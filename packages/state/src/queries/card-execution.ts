/**
 * Card-execute run hook — conversation-backed adapter (actor kernel).
 *
 * 分层 Phase 3：history→snapshot 转换与状态合成是纯状态机，在
 * @pin-ai/core 的 machines/card-execution.ts（可回放测试）；本文件只剩
 * React 生命周期编排——reducer、条件轮询 loop（running 时 1.5s，
 * needs_input/pending_done/terminal 停）、empty-thread bootstrap 守卫、
 * lastMessagePayload 的 live/hydration 双路径、5 个 action 方法。
 *
 * 对外保持迁移前 hooks/useCardExecutionRun.ts 的接口形状（snapshot /
 * events / 5 actions），ChatDetailView 的渲染层零改动。
 *
 *   - Initial load: GET /api/conversation/history (newest page, limit
 *     200), fold into RunSnapshot via chatHistoryToSnapshot.
 *   - Live tail: poll history every 1.5s while status is `running`. The
 *     drawer is a read-mostly preview; the full live view is CardChat.
 *   - reply / continueWith: POST /api/conversation/send (202 — async in
 *     the worker), then re-arm polling; next polls watch `active`.
 *   - cancel / confirmDone / retry: local status flips（chat thread 本身
 *     持久存在），见各方法注释。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  buildCardThreadTextFeedbackBody,
  type ConversationHistoryPage,
  cardSessionKeyFor,
  chatHistoryToSnapshot,
  conversationHistory,
  conversationSend,
  countProposeActions,
  deriveLastMessagePayload,
  mergeAuditFields,
  messagePayloadEqual,
  proxyPost,
  toMessagePayload,
  CARD_EXECUTION_TERMINAL,
  type LastMessagePayload,
  type RunSnapshot,
  type RunStatus,
  type SSEEvent,
} from "@pin-ai/core";

// ── Internal reducer ─────────────────────────────────────────────────────

interface State {
  snapshot: RunSnapshot | null;
  events: SSEEvent[];
  loading: boolean;
  error: string | null;
}

type Action =
  | { kind: "loading" }
  | { kind: "snapshot"; snapshot: RunSnapshot }
  | { kind: "error"; message: string }
  | { kind: "patch_status"; status: RunStatus }
  | { kind: "reset" };

function reducer(prev: State, a: Action): State {
  switch (a.kind) {
    case "loading":
      return { ...prev, loading: true, error: null };
    case "snapshot":
      return {
        snapshot: a.snapshot,
        events: a.snapshot.events,
        loading: false,
        error: null,
      };
    case "error":
      return { ...prev, loading: false, error: a.message };
    case "patch_status":
      if (!prev.snapshot) return prev;
      return { ...prev, snapshot: { ...prev.snapshot, status: a.status } };
    case "reset":
      return { snapshot: null, events: [], loading: false, error: null };
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────

export interface UseCardExecutionRun {
  snapshot: RunSnapshot | null;
  events: SSEEvent[];
  loading: boolean;
  error: string | null;
  /** POST the user's reply as a HumanMessage on the card's chat
   *  thread. Same channel for chip taps and free-text input. */
  reply: (text: string) => Promise<void>;
  /** Local-only: clear local state and let the parent navigate
   *  away. The chat thread persists on the backend either way; user
   *  can come back via the home card any time. */
  cancel: (reason?: string) => Promise<void>;
  /** Send a "retry" bootstrap message to restart card execution. The
   *  chat thread is reused; we return the same sessionKey so the
   *  parent doesn't have to swap runIds. */
  retry: () => Promise<string>;
  /** Re-fetch chat history (used after a reply / on focus). */
  refresh: () => Promise<void>;
  /** Local-only: mark the run as `done` so the toolbar collapses to
   *  the feedback row. No equivalent backend endpoint on chat-stream;
   *  the upstream "Done" gesture is just a UI confirmation. */
  confirmDone: () => Promise<void>;
  /** Send a "continue with this instruction" message. Same as reply
   *  semantically but used by ContinueReplyBox in pending_done state. */
  continueWith: (reason: string) => Promise<string>;
  /** Latest propose_action payload, with audit fields merged forward
   *  across follow-up calls. */
  lastMessagePayload: LastMessagePayload | null;
  /** How many distinct propose_action tool calls the agent has emitted
   *  on this card-thread so far. Flips "Generated draft" → "Updated
   *  draft v2" and re-expands the draft card on each new version. */
  messageCount: number;
}

const NULL_STATE: State = {
  snapshot: null,
  events: [],
  loading: false,
  error: null,
};

const POLL_INTERVAL_MS = 1500;

/** Enqueue the empty-thread bootstrap message (202 — the turn runs async
 *  in the worker; the polling loop watches it land via `active`). The
 *  cardContext rides as a field; the backend injects it as the thread's
 *  <card_context> SystemMessage on the first turn. */
async function sendBootstrap(
  sessionKey: string,
  message: string,
  cardContext?: Record<string, unknown>,
): Promise<void> {
  await conversationSend(sessionKey, message, { cardContext });
}

export interface UseCardExecutionRunOptions {
  /** When the chat thread is empty on mount, fire this as the user's
   *  first HumanMessage so the card-execution agent starts working
   *  immediately. Mirrors upstream's CardChat bootstrap mechanism —
   *  the home Drawer's Confirm button passes the card's
   *  primaryAction.label here so the agent treats Approve as
   *  "do this action". The text is sent exactly once per (mount,
   *  empty-thread) pair; subsequent visits to a thread with existing
   *  history skip the bootstrap. */
  bootstrap?: string;
  /** Current card payload. Sent with every card-thread turn so old
   *  backend deployments and existing threads still know which card
   *  the user means when they say "this card". */
  cardContext?: Record<string, unknown>;
  /** Sync-B3b：本地同步库读取（注入与 conversation runtime 同构）。
   *  注入时 drawer 首帧用本地 snapshot 秒开；网络轮询照旧并立即校正
   *  （awaiting/active 只有网络有，HITL 等状态以网络为准）。 */
  localHistory?: (
    threadId: string,
    limit: number,
  ) => Promise<ConversationHistoryPage | null>;
}

export function useCardExecutionRun(
  runId: string | null,
  options: UseCardExecutionRunOptions = {},
): UseCardExecutionRun {
  const { bootstrap, cardContext, localHistory } = options;
  const localHistoryRef = useRef(localHistory);
  useEffect(() => {
    localHistoryRef.current = localHistory;
  }, [localHistory]);
  const [state, dispatch] = useReducer(reducer, NULL_STATE);
  // Track which session_keys we've already fired a bootstrap into so
  // a parent re-render or a polling tick can't double-send the same
  // initial message. Per-mount Set; resets when the hook unmounts.
  const bootstrappedRef = useRef<Set<string>>(new Set());

  const snapshotRef = useRef<RunSnapshot | null>(state.snapshot);
  useEffect(() => {
    snapshotRef.current = state.snapshot;
  }, [state.snapshot]);

  const [lastMessagePayload, setLastMessagePayload] =
    useState<LastMessagePayload | null>(null);

  useEffect(() => {
    setLastMessagePayload(null);
  }, [runId]);

  // Live path: snapshot.pendingInput changes → cache the propose_action
  // args. Merge audit fields forward so re-drafts (which often omit
  // plan / dangerous_actions / risks) don't blank the home Drawer
  // pre-review view.
  useEffect(() => {
    const p = state.snapshot?.pendingInput;
    if (p && p.kind === "message") {
      setLastMessagePayload((prev) => {
        const incoming = toMessagePayload(p);
        const merged = mergeAuditFields(incoming, prev);
        return messagePayloadEqual(prev, merged) ? prev : merged;
      });
    }
  }, [state.snapshot?.pendingInput]);

  // Hydration path: derive from the events log (audit fields merged
  // forward — pure projection in core).
  useEffect(() => {
    const merged = deriveLastMessagePayload(state.events);
    if (merged === null) return;
    setLastMessagePayload((prev) =>
      messagePayloadEqual(prev, merged) ? prev : merged,
    );
  }, [state.events]);

  const fetchSnapshot = useCallback(
    async (id: string): Promise<RunSnapshot> => {
      const session = cardSessionKeyFor(id);
      // Newest page at the max page size — card threads are short (a few
      // turns), so one page covers the propose_action history the drawer
      // derives plan_revisions / messageCount from.
      const page = await conversationHistory(session, { limit: 200 });
      return chatHistoryToSnapshot(session, page);
    },
    [],
  );

  // Re-arms the polling loop after a 202 send (reply / continueWith): the
  // turn runs async in the worker, so the effect below must resume polling
  // until it lands in history. Bumped instead of calling the loop directly
  // so the effect's abort/cleanup semantics stay in one place.
  const [pollEpoch, setPollEpoch] = useState(0);

  // Mount / runId change / pollEpoch bump: fetch the snapshot + poll while
  // status is `running` (in-flight turn or fresh thread). Stop at
  // needs_input / pending_done / terminal — no new history is expected
  // until the user acts.
  useEffect(() => {
    if (!runId) {
      dispatch({ kind: "reset" });
      return;
    }
    let abort = false;
    // Initial load only — a pollEpoch re-arm keeps the current snapshot
    // rendered (the reply already patched status to "resuming").
    if (!snapshotRef.current) dispatch({ kind: "loading" });

    (async () => {
      // ── B3b 本地首帧：drawer 秒开。网络轮询紧随其后覆盖（HITL 的
      // awaiting/active 只有网络有，状态以网络 snapshot 为准）。
      if (!snapshotRef.current) {
        try {
          const session = cardSessionKeyFor(runId);
          const localPage = await localHistoryRef.current?.(session, 200);
          if (localPage && !abort && !snapshotRef.current) {
            dispatch({
              kind: "snapshot",
              snapshot: chatHistoryToSnapshot(session, localPage),
            });
          }
        } catch {
          /* best-effort */
        }
      }
      if (abort) return;
      while (!abort) {
        try {
          const snap = await fetchSnapshot(runId);
          if (abort) return;
          dispatch({ kind: "snapshot", snapshot: snap });

          // Empty-thread bootstrap: when the parent provided a bootstrap
          // message (typical for the Drawer's Confirm path) AND the thread
          // has zero events AND no turn is in flight (metadata.inFlight —
          // the fanout's bootstrap turn may be running right now with
          // nothing persisted yet; firing here would double-send it),
          // enqueue the bootstrap exactly once and re-poll. Without this
          // the FE would hang on "preparing the plan…" for any card whose
          // fan-out missed (limit, transient failure).
          const sessionKey = cardSessionKeyFor(runId);
          if (
            bootstrap
            && snap.events.length === 0
            && !snap.metadata.inFlight
            && !bootstrappedRef.current.has(sessionKey)
          ) {
            bootstrappedRef.current.add(sessionKey);
            try {
              await sendBootstrap(sessionKey, bootstrap, cardContext);
              // 202 — re-poll immediately; `active` shows up on the next
              // history read and keeps the loop alive until the turn lands.
              continue;
            } catch (e) {
              // Don't trap the user forever on a failed bootstrap —
              // surface as snapshot error and stop polling so the FE
              // shows whatever upstream's onError handler renders.
              const msg = e instanceof Error ? e.message : String(e);
              dispatch({ kind: "error", message: msg });
              return;
            }
          }

          if (CARD_EXECUTION_TERMINAL.has(snap.status) || snap.status === "needs_input"
              || snap.status === "pending_done") {
            // Steady state — stop polling. reply/continueWith bump
            // pollEpoch to re-arm; refresh/confirmDone fetch directly.
            return;
          }
        } catch (e: unknown) {
          if (abort) return;
          const msg = e instanceof Error ? e.message : String(e);
          dispatch({ kind: "error", message: msg });
        }
        // Wait before re-polling. Short interval so the
        // "preparing the plan" UI flips to "needs your input" snappily
        // once the worker finishes the first propose_action turn.
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    })();

    return () => {
      abort = true;
    };
  }, [bootstrap, cardContext, fetchSnapshot, runId, pollEpoch]);

  const reply = useCallback(
    async (text: string) => {
      if (!runId) return;
      const trimmed = text.trim();
      if (!trimmed) throw new Error("reply text must be non-empty");
      const session = cardSessionKeyFor(runId);
      // Card-thread free text doubles as card feedback (best-effort).
      const feedbackBody = buildCardThreadTextFeedbackBody({
        sessionKey: session,
        userText: trimmed,
        cardContext,
      });
      if (feedbackBody) {
        try {
          await proxyPost("/feedback", feedbackBody);
        } catch {
          // Feedback persistence is best-effort; chat must still proceed.
        }
      }
      dispatch({ kind: "patch_status", status: "resuming" });
      // 202 — the turn runs async in the worker. cardContext rides as a
      // field (the backend injects <card_context> as the thread's first-turn
      // SystemMessage; follow-ups rely on the persisted one — same
      // semantics as CardChat's ConversationView). Re-arm the polling loop
      // to watch the turn land in history via `active`.
      await conversationSend(session, trimmed, { cardContext });
      setPollEpoch((e) => e + 1);
    },
    [cardContext, runId],
  );

  const cancel = useCallback(
    async (_reason?: string) => {
      // Chat threads persist on the backend; cancel is purely a UI
      // "I'm leaving this view" gesture. We flip local status so the
      // ChatDetailView animation can complete; the caller (parent)
      // then navigates away.
      dispatch({ kind: "patch_status", status: "cancelled" });
    },
    [],
  );

  const retry = useCallback(async (): Promise<string> => {
    if (!runId) throw new Error("retry: no runId");
    // Same thread reused — fire a bootstrap-style "please retry" turn
    // and refresh. The agent re-reads card_context from its system
    // message (already persisted) and starts over.
    await reply("Please retry this card from scratch.");
    return runId;
  }, [runId, reply]);

  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      const snap = await fetchSnapshot(runId);
      dispatch({ kind: "snapshot", snapshot: snap });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      dispatch({ kind: "error", message: msg });
    }
  }, [runId, fetchSnapshot]);

  const confirmDone = useCallback(async () => {
    // Local-only — chat-stream has no "run finalized" concept. The
    // toolbar reads snapshot.status === "done" to collapse to the
    // feedback row, so a status flip is all we need.
    dispatch({ kind: "patch_status", status: "done" });
  }, []);

  const continueWith = useCallback(
    async (reason: string): Promise<string> => {
      if (!runId) throw new Error("continueWith: no runId");
      const trimmed = reason.trim();
      if (!trimmed) throw new Error("continueWith: reason must be non-empty");
      await reply(trimmed);
      return runId;
    },
    [runId, reply],
  );

  const messageCount = useMemo(
    () => countProposeActions(state.events),
    [state.events],
  );

  return {
    snapshot: state.snapshot,
    events: state.events,
    loading: state.loading,
    error: state.error,
    reply,
    cancel,
    retry,
    refresh,
    confirmDone,
    continueWith,
    lastMessagePayload,
    messageCount,
  };
}
