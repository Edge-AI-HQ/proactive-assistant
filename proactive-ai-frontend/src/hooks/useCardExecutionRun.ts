/**
 * Card-execute run hook — conversation-backed adapter (actor kernel).
 *
 * Cards run on the unified `/api/conversation/*` pipeline scoped by
 * session_key `card-thread-<card_id>` — the same thread CardChat's
 * ConversationView drives. The agent (`card_execution.py`) calls the
 * `propose_action` tool to surface chips / drafts / plan to the user,
 * and the user's reply is just a normal user turn on the same thread.
 *
 * This file preserves the EXTERNAL shape the legacy ChatDetailView
 * was built against (snapshot.status / pendingInput / result, events
 * log of SSE-shaped envelopes, the 5 action methods) so the rich
 * visual layer keeps working without touching it. Internally:
 *
 *   - Initial load: GET /api/conversation/history (newest page,
 *     limit 200), fold the persisted turns into a RunSnapshot + a
 *     synthetic events log (chat:tool:start / chat:tool:result /
 *     input_required for every propose_action call). The page's
 *     `active` / `awaiting` fields mark an in-flight / HITL-paused
 *     turn that isn't in the rows yet (finalize writes on completion).
 *   - Live tail: poll history every 1.5s while status is `running`.
 *     The drawer is a read-mostly preview, so polling beats wiring a
 *     stream subscription here; the full live view is CardChat.
 *   - reply / continueWith: POST /api/conversation/send (202 — the
 *     turn runs async in the worker), then re-arm the polling loop;
 *     the next polls watch `active` until the turn lands in history.
 *   - cancel / confirmDone / retry: no real backend equivalent. We
 *     update local state so the UI animation completes and the user
 *     can navigate; the chat thread itself persists either way.
 *
 * The runId argument the hook accepts is the FE-side identifier the
 * old ChatDetailView used; we treat it as the `card_id` and derive
 * `session_key = card-thread-<card_id>`. Callers pass the
 * IntentCard's string id verbatim.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { stripRequestOnlyCardContext } from "@/components/chat/card-chat-session";
import { buildCardThreadTextFeedbackBody } from "@/components/chat/card-feedback";
import {
  conversationHistory,
  conversationSend,
  proxyPost,
  type ConversationHistoryMessage,
  type ConversationHistoryPage,
  type ConversationHistoryToolCallPart,
} from "@/lib/api";

// ── Shared event envelope ─────────────────────────────────────────────────

export interface SSEEvent {
  type: string;
  ts?: number;
  traceId?: string;
  data?: Record<string, unknown>;
}

// ── Pending-input payload shapes ─────────────────────────────────────────

export interface ExecutionStep {
  tool: string;
  slug?: string | null;
  risk?: "read" | "safe_write" | "dangerous_write" | "blocked";
  summary: string;
}

export interface ExecuteArtifact {
  kind: "email_draft" | "message" | "doc" | "other";
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}

export interface DangerousAction {
  slug: string;
  args_preview: Record<string, unknown>;
  args_hash: string;
  risk_label: string;
}

/** Translated from the `propose_action` tool call's structured args.
 *  `kind: "message"` is kept so ChatDetailView's existing branches
 *  (which were written against the old `send_message` shape) keep
 *  working unchanged. */
export interface PendingInput {
  kind: "message";
  message: string;
  drafts?: ExecuteArtifact[];
  options?: string[] | null;
  plan?: ExecutionStep[];
  dangerous_actions?: DangerousAction[];
  risks?: string[];
}

// ── Snapshot shape ───────────────────────────────────────────────────────

export type RunStatus =
  | "running"
  | "needs_input"
  | "resuming"
  | "pending_done"
  | "done"
  | "error"
  | "cancelled";

export interface SideEffect {
  slug: string;
  args_hash: string;
  output_meta: unknown;
  is_error: boolean;
}

export interface RunResult {
  summary?: string;
  side_effects?: SideEffect[];
}

export interface LastMessagePayload {
  message: string;
  drafts: ExecuteArtifact[];
  options: string[] | null;
  plan: ExecutionStep[];
  dangerous_actions: DangerousAction[];
  risks: string[];
}

function messagePayloadEqual(
  a: LastMessagePayload | null,
  b: LastMessagePayload | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function toMessagePayload(p: PendingInput): LastMessagePayload {
  return {
    message: p.message,
    drafts: p.drafts ?? [],
    options: p.options ?? null,
    plan: p.plan ?? [],
    dangerous_actions: p.dangerous_actions ?? [],
    risks: p.risks ?? [],
  };
}

function mergeAuditFields(
  incoming: LastMessagePayload,
  prev: LastMessagePayload | null,
): LastMessagePayload {
  if (!prev) return incoming;
  const incomingHasAudit =
    incoming.plan.length > 0
    || incoming.dangerous_actions.length > 0
    || incoming.risks.length > 0;
  if (incomingHasAudit) return incoming;
  return {
    ...incoming,
    plan: prev.plan,
    dangerous_actions: prev.dangerous_actions,
    risks: prev.risks,
  };
}

export interface RunSnapshot {
  runId: string;
  id: string;
  pipelineRunId: string | null;
  cardId: string;
  mode: "execute";
  status: RunStatus;
  pendingInput: PendingInput | null;
  result: RunResult | null;
  errorMessage: string | null;
  events: SSEEvent[];
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

// ── conversation history → RunSnapshot adapter ───────────────────────────

const CARD_THREAD_PREFIX = "card-thread-";

/** Narrowed text part of a history message (api.ts ConversationHistoryPart). */
interface HistoryTextPart {
  type: "text";
  text: string;
}

/** Pull the propose_action structured args out of a tool-call part.
 *  Tolerant: when `args` is missing (e.g. the call exceeded the 8 KB
 *  cap), the call is treated as if propose_action's payload were
 *  unavailable and the FE falls back to argsPreview-only rendering. */
function parseProposeAction(part: ConversationHistoryToolCallPart): PendingInput | null {
  if (part.toolName !== "propose_action") return null;
  const raw = part.args;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === "string" ? r.message : "";
  if (!message) return null;
  const drafts = Array.isArray(r.drafts)
    ? (r.drafts as ExecuteArtifact[])
    : undefined;
  const options = Array.isArray(r.options)
    ? (r.options as string[])
    : null;
  const plan = Array.isArray(r.plan)
    ? (r.plan as ExecutionStep[])
    : [];
  const dangerous_actions = Array.isArray(r.dangerous_actions)
    ? (r.dangerous_actions as DangerousAction[])
    : [];
  const risks = Array.isArray(r.risks) ? (r.risks as string[]) : [];
  return {
    kind: "message", message, drafts, options, plan, dangerous_actions, risks,
  };
}

/** Walk the conversation history page and synthesize the RunSnapshot
 *  shape ChatDetailView expects. Each tool-call becomes a
 *  (chat:tool:start, chat:tool:result?) pair in the events log so the
 *  existing eventsToMessages projection keeps working; each
 *  propose_action additionally emits an input_required event so the
 *  pause-history walker (StaticPauseCard) finds it. The page's
 *  `active` / `awaiting` mark an in-flight turn not yet in the rows —
 *  they drive the status synthesis and the bootstrap guard
 *  (metadata.inFlight). */
function chatHistoryToSnapshot(
  sessionKey: string,
  page: ConversationHistoryPage,
): RunSnapshot {
  const events: SSEEvent[] = [];
  // Cards never heartbeat; filter defensively so the walker only sees
  // user/assistant turns (the shared history shape includes 'heartbeat').
  const messages: ConversationHistoryMessage[] = (
    Array.isArray(page.messages) ? page.messages : []
  ).filter((m) => m.role !== "heartbeat");

  let latestProposeAction: PendingInput | null = null;
  let finalText = "";
  let saw_error_part = false;

  // Walk messages in order; each time we see a propose_action we open a
  // new "pause slot" and the NEXT user HumanMessage fills it. ChatDetailView's
  // StaticPauseCard reads these via `snapshot.metadata.plan_revisions[i].reply`
  // — they're the durable source for past user replies (survives refresh /
  // SSE reconnect). Without this, the FE shows the agent pause card but no
  // user reply bubble for any pause prior to the current session.
  const planRevisions: Array<{ reply: string }> = [];
  let awaitingUserReplyForPause = false;

  for (const m of messages) {
    const parts = Array.isArray(m.parts) ? m.parts : [];
    // User HumanMessage: if it's the first user turn AFTER a propose_action,
    // pair it with that pause slot. Concatenate text parts (rare to have
    // multiple, but safe).
    if (m.role === "user" && awaitingUserReplyForPause) {
      const replyText = parts
        .filter((p): p is HistoryTextPart => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim();
      if (replyText) {
        planRevisions.push({ reply: stripRequestOnlyCardContext(replyText) });
        awaitingUserReplyForPause = false;
      }
    }
    for (const part of parts) {
      if (part.type === "tool-call") {
        events.push({
          type: "chat:tool:start",
          ts: m.createdAt,
          data: {
            toolCallId: part.toolCallId,
            name: part.toolName,
            argsPreview: part.argsPreview ?? "",
            args: part.args,
          },
        });
        if (part.status === "ok" || part.status === "error") {
          if (part.status === "error") saw_error_part = true;
          events.push({
            type: "chat:tool:result",
            ts: m.createdAt,
            data: {
              toolCallId: part.toolCallId,
              isError: part.status === "error",
              meta: part.meta ?? "",
            },
          });
        }
        const proposed = parseProposeAction(part);
        if (proposed) {
          latestProposeAction = proposed;
          events.push({
            type: "input_required",
            ts: m.createdAt,
            data: proposed as unknown as Record<string, unknown>,
          });
          // Mark the pause slot as awaiting the next user reply.
          awaitingUserReplyForPause = true;
        }
      } else if (part.type === "text" && m.role === "assistant") {
        // The agent's prose. Accumulate as the eventual `result`
        // summary; if it sits AFTER all propose_action calls in the
        // last assistant turn, that's the final report.
        finalText += part.text;
      }
    }
  }

  // Status synthesis. An in-flight turn (page.active / page.awaiting) is NOT
  // in the rows yet — finalize writes on completion — so it overrides the
  // last-row reading; without it, a reply would flash back to the previous
  // propose_action's "needs_input" while the agent is actually running.
  // Otherwise look at the LAST assistant turn:
  //   - tool call in flight (status="running") and not yet a
  //     propose_action → status="running"
  //   - propose_action present AND no user reply after it
  //     (i.e. it's the latest assistant turn) → status="needs_input"
  //   - text-only completion (no propose_action) → status="pending_done"
  //   - any chat:tool:result with isError + nothing past it → "error"
  let status: RunStatus = "running";
  let result: RunResult | null = null;
  let errorMessage: string | null = null;
  const inFlight = Boolean(page.active || page.awaiting);

  if (page.awaiting) {
    // HITL pause: a side-effect tool awaits approval. The drawer can't
    // render the approval gate (CardChat's ConversationView does) — surface
    // as needs_input so the shimmer stops and the user opens the chat.
    status = "needs_input";
  } else if (page.active) {
    status = "running";
  } else if (messages.length === 0) {
    // Fresh thread (fanout hasn't fired or never reached the worker).
    // Surface as "running" so the FE shows the preparing spinner.
    status = "running";
  } else {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "user") {
      // User just replied; agent is presumably mid-turn (we'll see
      // its assistant reply on the next poll).
      status = "running";
    } else {
      // Assistant message — inspect its parts.
      const parts = Array.isArray(lastMsg.parts) ? lastMsg.parts : [];
      const hasProposeAction = parts.some(
        (p): p is ConversationHistoryToolCallPart =>
          p.type === "tool-call" && p.toolName === "propose_action",
      );
      const hasRunningTool = parts.some(
        (p): p is ConversationHistoryToolCallPart =>
          p.type === "tool-call" && p.status === "running",
      );
      const hasFinalText = parts.some(
        (p): p is HistoryTextPart => p.type === "text" && Boolean(p.text),
      );
      if (hasRunningTool) {
        status = "running";
      } else if (hasProposeAction && latestProposeAction) {
        status = "needs_input";
      } else if (hasFinalText) {
        status = "pending_done";
        result = { summary: finalText.trim(), side_effects: [] };
      } else if (saw_error_part) {
        status = "error";
        errorMessage = "Agent run failed; see tool errors above.";
      } else {
        status = "running";
      }
    }
  }

  const cardId = sessionKey.startsWith(CARD_THREAD_PREFIX)
    ? sessionKey.slice(CARD_THREAD_PREFIX.length)
    : sessionKey;

  return {
    runId: sessionKey,
    id: sessionKey,
    pipelineRunId: null,
    cardId,
    mode: "execute",
    status,
    pendingInput: status === "needs_input" ? latestProposeAction : null,
    result,
    errorMessage,
    events,
    metadata: { plan_revisions: planRevisions, inFlight },
    createdAt: null,
    updatedAt: null,
    completedAt: null,
  };
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["done", "error", "cancelled"]);

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

function sessionKeyFor(runId: string): string {
  if (runId.startsWith(CARD_THREAD_PREFIX)) return runId;
  return `${CARD_THREAD_PREFIX}${runId}`;
}

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
}

export function useCardExecutionRun(
  runId: string | null,
  options: UseCardExecutionRunOptions = {},
): UseCardExecutionRun {
  const { bootstrap, cardContext } = options;
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

  // Hydration path: walk events newest→oldest looking for the most
  // recent propose_action that DID carry audit fields, so the Drawer's
  // pre-review keeps showing plan / dangerous_actions / risks across
  // re-drafts that omitted them.
  useEffect(() => {
    let latest: LastMessagePayload | null = null;
    let audit: Pick<
      LastMessagePayload, "plan" | "dangerous_actions" | "risks"
    > | null = null;
    for (let i = state.events.length - 1; i >= 0; i--) {
      const ev = state.events[i];
      if (ev.type !== "input_required") continue;
      const data = ev.data as PendingInput | undefined;
      if (!data || data.kind !== "message") continue;
      const payload = toMessagePayload(data);
      if (latest === null) latest = payload;
      if (
        audit === null
        && (payload.plan.length > 0
          || payload.dangerous_actions.length > 0
          || payload.risks.length > 0)
      ) {
        audit = {
          plan: payload.plan,
          dangerous_actions: payload.dangerous_actions,
          risks: payload.risks,
        };
      }
      if (latest && audit) break;
    }
    if (latest === null) return;
    const merged: LastMessagePayload = audit
      ? { ...latest, ...audit }
      : latest;
    setLastMessagePayload((prev) =>
      messagePayloadEqual(prev, merged) ? prev : merged,
    );
  }, [state.events]);

  const fetchSnapshot = useCallback(
    async (id: string): Promise<RunSnapshot> => {
      const session = sessionKeyFor(id);
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
          const sessionKey = sessionKeyFor(runId);
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

          if (TERMINAL.has(snap.status) || snap.status === "needs_input"
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
      const session = sessionKeyFor(runId);
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

  const messageCount = useMemo(() => {
    let n = 0;
    for (const ev of state.events) {
      if (ev.type !== "input_required") continue;
      const data = ev.data as { kind?: string } | undefined;
      if (data?.kind === "message") n++;
    }
    return n;
  }, [state.events]);

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
