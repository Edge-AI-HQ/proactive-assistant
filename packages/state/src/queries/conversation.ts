/**
 * Runtime hook for the unified conversation agent (main / card threads).
 *
 * 纯逻辑（history→entries 转换、resync 三段合并、HITL partial 重建）在
 * @pin-ai/core 的 machines/conversation.ts（回放测试）；LiveContentBuilder
 * （流式 turn 组装）在 core 的 machines/tool-steps.ts。本文件只剩 React
 * 编排：SSE 长连接生命周期（首连 resync / 游标重连 / capped backoff）、
 * builder 的 ref 桥接与 flush、busy/HITL 等 actions。
 *
 * 回复是异步的：turn 经 conversationStream() 的长连接推流到达，不是 send
 * 的响应；HITL 暂停以 chat:requires_action 帧出现，由 conversationDecision()
 * 解决。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  awaitingPartialEntry,
  conversationCancel,
  conversationDeleteMessage,
  conversationDecision,
  conversationHistory,
  conversationSend,
  conversationStream,
  conversationUpdateMessage,
  historyToEntries,
  mergeTranscriptOnResync,
  type ConversationConnectionState,
  type ConversationEntry,
  type ConversationHistoryPage,
  type ConversationSseEnvelope,
  type ConversationUserEntry,
  type HitlRequiresAction,
} from "@pin-ai/core";

import { createEnvelopeHandler } from "./conversation/sse-handler";
import { useTurnAssembly } from "./conversation/turn-assembly";

export type {
  ConversationAssistantEntry,
  ConversationConnectionState,
  ConversationEntry,
  ConversationUserEntry,
} from "@pin-ai/core";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/** Page size for the initial history fetch + each "load older" page on
 *  scroll-up. Backend caps at 500; this is a comfortable screenful or two
 *  of debug-on heartbeats. */
const HISTORY_PAGE_SIZE = 200;

function isRecoverableStreamDisconnect(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("network connection was lost");
}

export interface ConversationRuntimeOpts {
  /** Thread to address. Omit → the user's main thread.
   *  `card-thread-<id>` → a per-card execution thread. */
  session?: string;
  /** Card JSON injected on the first send (feedback-from-card / first card
   *  open). Sent once, then cleared. */
  cardContext?: Record<string, unknown>;
  /** Auto-fired first user message when the thread has no history yet (e.g. a
   *  card's primaryAction label, mirroring the server-side fanout bootstrap). */
  bootstrap?: string;
  /** Sync-B3 门铃：本 thread 的一个 turn 已被后端 finalize/persist——
   *  调用方触发该 thread 的本地增量同步（拉刚落库的行）。通知拉取分离：
   *  客户端不把 SSE 帧自行拼成行。chat:persisted 与 chat:done 都会触发，
   *  幂等/节流由实现方负责。 */
  onTurnPersisted?: (threadId: string) => void;
  /** Sync-B3b 读路径：本地同步库的 history page 读取（无 driver/空库返回
   *  null）。注入时首屏「本地优先 + 网络校正」：本地页立即渲染（ready
   *  提前、离线可读），网络页随后整体重建校正（awaiting/active/replayFrom
   *  只有网络有）。向旧翻页（loadMoreHistory）仍走网络。 */
  localHistory?: (threadId: string, limit: number) => Promise<ConversationHistoryPage | null>;
  /** Fired when the turn settles: on every `chat:done` (turn ended — clean,
   *  errored or cancelled) and on `chat:requires_action` (HITL pause). Card
   *  chat wires this back to the card layer so the sphere/timeline status
   *  updates the moment the agent finishes/pauses instead of waiting for
   *  the next /cards poll. Distinct from `onTurnPersisted` (the local-sync
   *  doorbell). Best-effort — a dropped stream means no call, so consumers
   *  keep their own polling as the backstop. */
  onTurnDone?: () => void;
}

export interface UseConversationRuntimeResult {
  transcript: ConversationEntry[];
  connection: ConversationConnectionState;
  /** True once the initial /history fetch has resolved (success or empty). */
  ready: boolean;
  sendMessage: (text: string) => Promise<void>;
  /** True from the moment the user sends until the resulting turn ends
   *  (chat:done/error). Bridges the cold-start gap BEFORE the turn starts
   *  streaming, so the composer can show Stop + gate sends and the UI can show
   *  a pending indicator immediately — not only once `chat:thinking` lands. */
  busy: boolean;
  /** Resend a user message whose `/send` POST failed (renders a retry
   *  affordance on the bubble). Clears the failed flag on success. */
  retryMessage: (id: string, text: string) => Promise<void>;
  /** Stop the in-flight agent turn. Finalizes the current turn locally for
   *  instant feedback, then asks the backend to cancel it. */
  stop: () => Promise<void>;
  /** Edit a queued user message before the worker claims it. */
  updateQueuedMessage: (id: string, text: string) => Promise<void>;
  /** Remove a queued user message before the worker claims it. */
  deleteQueuedMessage: (id: string) => Promise<void>;
  /** Cancel the current run and promote a queued message to run next. */
  interruptQueuedMessage: (id: string) => Promise<void>;
  /** Regenerate the latest assistant turn: drops it locally and re-runs the
   *  latest user message with regenerate=true (backend pops the stale reply). */
  regenerateLast: () => Promise<void>;
  /** Resolved server-side thread id (from the stream's hello event). `null`
   *  until the stream opens. Card sessions know it up front; the main thread's
   *  id is server-resolved. Used to key the browser live view + todo store. */
  threadId: string | null;
  /** True if older history pages exist beyond the current transcript head.
   *  Drives the "load older" affordance (e.g. virtuoso's `startReached`). */
  hasMoreHistory: boolean;
  /** Fetch the next older page and prepend it to the transcript. No-op if
   *  there are no more pages, the cursor is unavailable, or another load
   *  is in flight (re-entrancy guard). Throws on backend stale-cursor (the
   *  caller should refetch the newest page). */
  loadMoreHistory: () => Promise<void>;
  /** Non-null when the turn paused on a side-effect tool awaiting approval
   *  (chat:requires_action). Render a HitlApprovalCard. */
  awaitingDecision: HitlRequiresAction | null;
  /** Resolve the pending HITL approval (approve/reject + optional message);
   *  the run resumes via Command(resume=) and streams the rest of the turn. */
  submitDecision: (
    decision: "approve" | "reject" | "edit" | "respond",
    message?: string,
  ) => Promise<void>;
}

export function useConversationRuntime(
  opts?: ConversationRuntimeOpts,
): UseConversationRuntimeResult {
  // sessionKey is now an explicit thread id resolved by the caller
  // (ConversationView via conversationInit); "" until resolved → connect idles.
  const session = opts?.session ?? "";
  const bootstrap = opts?.bootstrap;
  // 门铃回调进 ref：SSE 处理器不因回调身份变化重建/重订阅。
  const onTurnPersistedRef = useRef(opts?.onTurnPersisted);
  useEffect(() => {
    onTurnPersistedRef.current = opts?.onTurnPersisted;
  }, [opts?.onTurnPersisted]);
  const localHistoryRef = useRef(opts?.localHistory);
  useEffect(() => {
    localHistoryRef.current = opts?.localHistory;
  }, [opts?.localHistory]);
  // 卡片层门铃同款 ref 化:回调身份变化不重订阅 SSE。
  const onTurnDoneRef = useRef(opts?.onTurnDone);
  useEffect(() => {
    onTurnDoneRef.current = opts?.onTurnDone;
  }, [opts?.onTurnDone]);
  // Card context is sent on the first message only, then cleared.
  const cardCtxRef = useRef<Record<string, unknown> | null>(opts?.cardContext ?? null);
  const bootstrappedRef = useRef(false);
  const [transcript, setTranscript] = useState<ConversationEntry[]>([]);
  const [connection, setConnection] =
    useState<ConversationConnectionState>("connecting");
  const [ready, setReady] = useState(false);
  // Pagination state for the initial /history fetch + scroll-up loads. The
  // cursor lives in a ref because `loadMoreHistory` reads it without needing
  // to re-render; `hasMoreHistory` is state so the UI can re-render when
  // the head of the list is reached.
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const oldestCursorRef = useRef<number | null>(null);
  const loadingMoreRef = useRef(false);
  // True while we're awaiting / streaming a user-initiated turn. Set on send,
  // cleared on the turn's chat:done/error (also on stop + reconnect resync).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const [awaitingDecision, setAwaitingDecision] =
    useState<HitlRequiresAction | null>(null);
  const awaitingDecisionRef = useRef<HitlRequiresAction | null>(null);
  useEffect(() => {
    awaitingDecisionRef.current = awaitingDecision;
  }, [awaitingDecision]);
  // The card session id is known up front; the main thread id arrives in the
  // stream's hello event. Mirrored into a ref so the SSE handler can key the
  // todo store without re-subscribing.
  const [threadId, setThreadId] = useState<string | null>(session || null);
  const threadIdRef = useRef<string | null>(session || null);
  // Streaming-turn assembly (builder + its transcript entry, flushed from SSE
  // deltas). Turn refs + helpers live in useTurnAssembly so the streaming-turn
  // lifecycle is one unit; the SSE handler + connect loop drive them.
  const {
    builderRef,
    turnIdRef,
    turnPosRef,
    turnTraceRef,
    placeholderTurnIdRef,
    ensureTurn,
    flushTurn,
    finalizeTurn,
    createTurnPlaceholder,
    dropIdlePlaceholder,
  } = useTurnAssembly(setTranscript);
  // SSE resume cursor: the Redis Stream entry id of the last frame received.
  // Echoed back as Last-Event-ID on reconnect so the server replays the frames
  // missed during the gap (vs the old no-replay model that lost them). Null =
  // a fresh connection cycle → rebuild from history + tail from now.
  const lastEventIdRef = useRef<string | null>(null);

  // SSE envelope → transcript/turn state. The 12-case dispatch lives in
  // createEnvelopeHandler (sse-handler.ts); deps carry the turn-assembly
  // helpers/refs + state setters + doorbell refs. Stable while those are, so
  // the connect effect (which deps on it) doesn't re-subscribe per render.
  const handleEnvelope = useMemo(
    () =>
      createEnvelopeHandler({
        ensureTurn,
        flushTurn,
        finalizeTurn,
        builderRef,
        turnIdRef,
        turnTraceRef,
        placeholderTurnIdRef,
        threadIdRef,
        onTurnPersistedRef,
        onTurnDoneRef,
        setTranscript,
        setBusy,
        setAwaitingDecision,
        setThreadId,
      }),
    [
      ensureTurn,
      flushTurn,
      finalizeTurn,
      builderRef,
      turnIdRef,
      turnTraceRef,
      placeholderTurnIdRef,
    ],
  );

  // ── connection lifecycle: history → stream, reconnect with backoff ──
  useEffect(() => {
    if (!session) return; // not resolved yet (conversationInit pending) — idle
    let cancelled = false;
    let abort: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    // New connection cycle (mount / session change / debug toggle): no cursor,
    // so the first connect rebuilds from history. Mid-cycle reconnects keep the
    // cursor the stream loop sets below and resume via replay instead.
    lastEventIdRef.current = null;

    const connect = async () => {
      if (cancelled) return;
      abort = new AbortController();
      const signal = abort.signal;

      // First connect of this cycle (no cursor) resyncs from history so a
      // dropped stream can't leave the transcript missing turns that landed
      // while we were gone. A mid-cycle RECONNECT (cursor set) SKIPS this — the
      // server replays the gap from the cursor and the in-memory transcript
      // (including a half-streamed turn) is intact, so re-fetching would waste
      // a round-trip and reset the in-flight turn. `includeDebug` follows the
      // prop so a debug-toggle (which resets the cursor) refetches the matching
      // filtered view.
      const isResume = lastEventIdRef.current !== null;
      if (!isResume) {
        // ── B3b 本地优先：本地同步库有此 thread 即先渲染（0 网络首屏、
        // 离线可读），网络页随后到达走下方现有 merge 整体重建校正——
        // 本地条目与网络 history 同源同 id，merge 语义天然去重。本地
        // 读失败/空库静默跳过，行为与切换前完全一致。
        try {
          const localPage = await localHistoryRef.current?.(session, HISTORY_PAGE_SIZE);
          if (localPage && !cancelled) {
            const localEntries = historyToEntries(localPage.messages);
            setTranscript((prev) => mergeTranscriptOnResync(prev, localEntries, []));
            setHasMoreHistory(localPage.nextCursor !== null);
            oldestCursorRef.current = localPage.nextCursor;
            setReady(true);
          }
        } catch {
          /* local read is best-effort; network path below is authoritative */
        }
        if (cancelled) return;
        try {
          const page = await conversationHistory(session, {
            signal,
            limit: HISTORY_PAGE_SIZE,
          });
          if (cancelled) return;
          const history = historyToEntries(page.messages);
          // Redraw the in-progress (paused) assistant turn above the gate so a
          // refresh doesn't look like it wiped the thinking / tool calls
          // streamed before the interrupt (partialParts aren't persisted yet).
          const partial = awaitingPartialEntry(page.awaiting);
          if (partial) history.push(partial);
          // No plan re-hydration from history: todos are turn-scoped. A
          // finished turn's plan is retired by definition; an in-flight
          // turn's plan re-arrives via the replayFrom frame replay (the
          // same write_todos path as live).
          // Discard any half-streamed turn; history is the source of truth.
          builderRef.current = null;
          turnIdRef.current = null;
          turnPosRef.current = -1;
          // …but DON'T drop user messages history doesn't yet reflect —
          // merge 算法（carry / identity / text-claim 三段）在 core，详见
          // mergeTranscriptOnResync 的注释与回放测试。
          const serverEntries =
            page.active?.userEntries
            ?? (page.active && Array.isArray(page.active.userTexts)
              ? page.active.userTexts.map((t) => ({ text: t, clientId: null }))
              : []);
          setTranscript((prev) => mergeTranscriptOnResync(prev, history, serverEntries));
          setHasMoreHistory(page.nextCursor !== null);
          oldestCursorRef.current = page.nextCursor;
          // Rebuild (or clear) the HITL approval gate from current run state:
          // /stream won't replay requires_action, so a refresh relies on this.
          setAwaitingDecision(
            page.awaiting
              ? {
                  toolUseId: page.awaiting.toolUseId,
                  toolName: page.awaiting.toolName,
                  argsPreview: page.awaiting.argsPreview,
                  args: page.awaiting.args,
                  allowedDecisions: page.awaiting.allowedDecisions,
                }
              : null,
          );
          // In-flight turn on a fresh connect (refresh): its user bubble(s)
          // were merged into the rebuild above; here set the resume cursor so
          // the stream below replays the WHOLE turn (its agent frames rebuild
          // the assistant bubble as they arrive) instead of tailing from "$".
          // A just-sent turn has no frames yet (replayFrom null) — bubbles
          // only, frames come live. Stay busy until the turn ends.
          if (page.active?.replayFrom) {
            lastEventIdRef.current = page.active.replayFrom;
          }
          setBusy(page.active != null);
          setReady(true);
        } catch (err) {
          if (cancelled || signal.aborted) return;
          // History failed — keep whatever we have and still try the stream.
          setReady(true);
          console.warn("[proactive] history fetch failed:", err);
        }
      }

      if (cancelled) return;
      setConnection(attempt === 0 ? "connecting" : "reconnecting");

      // The backend's `conversation:hello` flips us to "open" (and resets
      // backoff) even on an idle stream. Each event carries the resume cursor
      // (lastEventId) we echo back on reconnect; a `conversation:resync` means
      // the cursor's stream expired server-side — drop it and reconnect, which
      // refetches history fresh.
      try {
        let opened = false;
        for await (const { event, lastEventId } of conversationStream<ConversationSseEnvelope>(
          session,
          signal,
          lastEventIdRef.current,
        )) {
          if (cancelled) return;
          if (!opened) {
            opened = true;
            setConnection("open");
            attempt = 0;
          }
          if (event.type === "conversation:resync") {
            lastEventIdRef.current = null;
            break;
          }
          if (lastEventId) lastEventIdRef.current = lastEventId;
          handleEnvelope(event);
        }
      } catch (err) {
        if (cancelled || signal.aborted) return;
        // RN/Expo sometimes reports a closed SSE as "network connection was lost";
        // the loop below reconnects, so keep dev UI free of a false warning.
        if (isRecoverableStreamDisconnect(err)) {
          console.debug("[proactive] stream disconnected; reconnecting:", err);
        } else {
          console.warn("[proactive] stream error:", err);
        }
      }

      // Stream ended (clean EOF or error). Reconnect with capped backoff.
      if (cancelled) return;
      setConnection("reconnecting");
      attempt += 1;
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** (attempt - 1),
        RECONNECT_MAX_MS,
      );
      reconnectTimer = setTimeout(() => void connect(), delay);
    };

    void connect();

    return () => {
      cancelled = true;
      setConnection("closed");
      abort?.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [handleEnvelope, session]);

  // Fetch the next older page and prepend to the transcript. Driven by
  // the view's scroll-up affordance (e.g. virtuoso's `startReached`). The
  // re-entrancy guard prevents a flood when the user pins the top.
  const loadMoreHistory = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const cursor = oldestCursorRef.current;
    if (!cursor || !hasMoreHistory) return;
    loadingMoreRef.current = true;
    try {
      const page = await conversationHistory(session, {
        before: cursor,
        limit: HISTORY_PAGE_SIZE,
      });
      const olderEntries = historyToEntries(page.messages);
      setTranscript((prev) => [...olderEntries, ...prev]);
      setHasMoreHistory(page.nextCursor !== null);
      oldestCursorRef.current = page.nextCursor;
    } catch (err) {
      // Only the 400 case (stale cursor — the filter list shifted under us)
      // is unrecoverable with the same cursor; collapse `hasMoreHistory` so
      // virtuoso doesn't pin the user into a 400 retry loop. For transient
      // failures (network blip / 5xx) leave the state alone — the next
      // start-reached fire (after a scroll-down-and-back-up) will retry.
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("failed: 400")) setHasMoreHistory(false);
      console.warn("[proactive] loadMoreHistory failed:", err);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [session, hasMoreHistory]);

  // POST a user message to the thread inbox, marking its bubble failed on
  // error (so the UI can offer a retry) and clearing the flag on success.
  // Never throws — send failures are surfaced on the bubble, not as an
  // unhandled rejection in the composer.
  const postUserMessage = useCallback(
    async (id: string, text: string, placeholderId: string | null) => {
      // Awaiting a turn from here on → composer flips to Stop + gates sends
      // immediately, before the (possibly slow first-turn) stream even starts.
      setBusy(true);
      setAwaitingDecision(null); // a new message supersedes any pending approval
      // card_context (if any) rides only the first send, then is cleared —
      // but only after the send succeeds, so a failed first send retries with it.
      const cardContext = cardCtxRef.current ?? undefined;
      try {
        // `id` IS the client message id (sendMessage mints a uuid): the
        // backend dedupes on it (a retry of a timed-out-but-landed POST
        // can't enqueue twice) and echoes it back on /history so the
        // bubble reconciles by identity.
        await conversationSend(session, text, { cardContext, clientMsgId: id });
        cardCtxRef.current = null;
        setTranscript((prev) =>
          prev.map((e) =>
            e.kind === "user" && e.id === id && e.failed
              ? { ...e, failed: false }
              : e,
          ),
        );
      } catch (err) {
        console.warn("[proactive] send failed:", err);
        setBusy(false); // no turn is coming; unblock the composer
        dropIdlePlaceholder(placeholderId); // no reply is coming either
        setTranscript((prev) =>
          prev.map((e) =>
            e.kind === "user" && e.id === id ? { ...e, failed: true } : e,
          ),
        );
      }
    },
    [session, dropIdlePlaceholder],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const queued = busyRef.current || awaitingDecisionRef.current !== null;
      // Optimistic: the reply does NOT come back on this POST — it arrives over
      // /stream — so we render the user's message locally immediately. One
      // uuid serves as entry id AND client message id (clientId), so a retry
      // (which gets the entry id back) naturally reuses the same identity.
      const id = crypto.randomUUID();
      setTranscript((prev) => [
        ...prev,
        {
          kind: "user",
          id,
          ts: Date.now(),
          text: trimmed,
          clientId: id,
          ...(queued ? { queued: true } : {}),
        },
      ]);
      const placeholderId = createTurnPlaceholder();
      await postUserMessage(id, trimmed, placeholderId);
    },
    [postUserMessage, createTurnPlaceholder],
  );

  const retryMessage = useCallback(
    async (id: string, text: string) => {
      setTranscript((prev) =>
        prev.map((e) =>
          e.kind === "user" && e.id === id ? { ...e, failed: false } : e,
        ),
      );
      const placeholderId = createTurnPlaceholder();
      await postUserMessage(id, text, placeholderId);
    },
    [postUserMessage, createTurnPlaceholder],
  );

  const updateQueuedMessage = useCallback(
    async (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const previous = transcript.find(
        (e): e is ConversationUserEntry =>
          e.kind === "user" && e.id === id && !!e.queued && !!e.clientId,
      );
      if (!previous) return;
      const clientMsgId = previous.clientId;
      if (!clientMsgId) return;
      setTranscript((prev) =>
        prev.map((e) => (e.kind === "user" && e.id === id ? { ...e, text: trimmed } : e)),
      );
      try {
        await conversationUpdateMessage(session, clientMsgId, trimmed);
      } catch (err) {
        console.warn("[proactive] queued message update failed:", err);
        const rollback = previous;
        setTranscript((prev) =>
          prev.map((e) => (e.kind === "user" && e.id === rollback.id ? rollback : e)),
        );
      }
    },
    [session, transcript],
  );

  const deleteQueuedMessage = useCallback(
    async (id: string) => {
      const removedIndex = transcript.findIndex(
        (e) => e.kind === "user" && e.id === id && !!e.queued && !!e.clientId,
      );
      if (removedIndex < 0) return;
      const removed = transcript[removedIndex] as ConversationUserEntry;
      const clientMsgId = removed.clientId;
      if (!clientMsgId) return;
      setTranscript((prev) => prev.filter((e) => !(e.kind === "user" && e.id === id)));
      try {
        await conversationDeleteMessage(session, clientMsgId);
      } catch (err) {
        console.warn("[proactive] queued message delete failed:", err);
        const rollback = removed;
        const idx = removedIndex;
        setTranscript((prev) => {
          if (prev.some((e) => e.kind === "user" && e.id === rollback.id)) return prev;
          const insertAt = idx >= 0 ? Math.min(idx, prev.length) : prev.length;
          return [...prev.slice(0, insertAt), rollback, ...prev.slice(insertAt)];
        });
      }
    },
    [session, transcript],
  );

  const interruptQueuedMessage = useCallback(
    async (id: string) => {
      const target = transcript.find(
        (e): e is ConversationUserEntry =>
          e.kind === "user" && e.id === id && !!e.queued && !!e.clientId,
      );
      if (!target) return;
      setTranscript((prev) =>
        prev.map((e) => (e.kind === "user" && e.id === id ? { ...e, queued: false } : e)),
      );
      finalizeTurn();
      setBusy(true);
      setAwaitingDecision(null);
      try {
        await conversationSend(session, target.text, {
          clientMsgId: target.clientId,
          interrupt: true,
        });
      } catch (err) {
        console.warn("[proactive] queued message interrupt failed:", err);
        setBusy(false);
        const rollback = target;
        setTranscript((prev) =>
          prev.map((e) =>
            e.kind === "user" && e.id === rollback.id ? { ...e, queued: true } : e,
          ),
        );
      }
    },
    [session, finalizeTurn, transcript],
  );

  // Regenerate the latest assistant turn: drop it locally, then re-send the
  // latest user text with regenerate=true. The backend pops the stale
  // AIMessage from state and streams a fresh reply in its place (it diffs
  // `message`, not `messages`). No new user bubble — the existing user turn is
  // reused, matching the old ConversationView Regenerate/Retry semantics.
  const regenerateLast = useCallback(async () => {
    if (busy) return;
    let lastUserText: string | null = null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i];
      if (e.kind === "user") {
        lastUserText = e.text;
        break;
      }
    }
    if (!lastUserText) return;
    setTranscript((prev) => {
      let lastAssistantIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].kind === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }
      return lastAssistantIdx >= 0 ? prev.slice(0, lastAssistantIdx) : prev;
    });
    // Same optimistic placeholder as a send — the pill replaces the dropped
    // turn immediately instead of popping in on the first frame.
    const placeholderId = createTurnPlaceholder();
    setBusy(true);
    setAwaitingDecision(null);
    try {
      // clientMsgId guards the regenerate against a timed-out-but-landed
      // POST being retried: a duplicate enqueue would merge into one batch,
      // fail the worker's single-message regenerate check, and replay the
      // text as two ordinary user turns. No bubble rides this id — a
      // regenerate reuses the existing one (meta.regenerate rows are
      // excluded from active.userEntries).
      await conversationSend(session, lastUserText, {
        regenerate: true,
        clientMsgId: crypto.randomUUID(),
      });
    } catch (err) {
      console.warn("[proactive] regenerate failed:", err);
      setBusy(false);
      dropIdlePlaceholder(placeholderId);
    }
  }, [busy, transcript, session, createTurnPlaceholder, dropIdlePlaceholder]);

  const stop = useCallback(async () => {
    // Optimistic: close the in-flight turn locally so the shimmer + Stop button
    // clear at once (the backend's terminal chat:done then finalizes a no-op).
    finalizeTurn();
    setBusy(false);
    // 取消即放弃待审批动作——本地立即清(断流收不到补发 done 帧的兜底)。
    setAwaitingDecision(null);
    try {
      await conversationCancel(session);
    } catch (err) {
      console.warn("[proactive] stop failed:", err);
    }
  }, [session, finalizeTurn]);

  // HITL: resolve the pending approval. The resumed turn streams the rest of
  // its parts back over /stream (the same builder keeps assembling), so we mark
  // busy + clear the pending action optimistically; on POST failure the
  // approval is restored so the user can retry.
  const submitDecision = useCallback(
    async (
      decision: "approve" | "reject" | "edit" | "respond",
      message?: string,
    ) => {
      const pending = awaitingDecision;
      if (!pending) return;
      setBusy(true);
      setAwaitingDecision(null);
      try {
        await conversationDecision(session, pending.toolUseId, decision, {
          message,
        });
      } catch (err) {
        console.warn("[proactive] decision failed:", err);
        setBusy(false);
        setAwaitingDecision(pending);
      }
    },
    [session, awaitingDecision],
  );

  // Auto-fire the bootstrap message once, when the thread starts empty (the
  // server-side fanout normally does this for cards; this is the fallback when
  // the user opens before/without a fanout). Skipped if history already exists.
  useEffect(() => {
    if (!bootstrap || bootstrappedRef.current || !ready) return;
    if (transcript.length > 0) {
      bootstrappedRef.current = true; // history present — fanout already ran
      return;
    }
    bootstrappedRef.current = true;
    void sendMessage(bootstrap);
  }, [bootstrap, ready, transcript.length, sendMessage]);

  return {
    transcript, connection, ready, sendMessage, busy, retryMessage, stop,
    updateQueuedMessage, deleteQueuedMessage, interruptQueuedMessage,
    regenerateLast,
    threadId,
    hasMoreHistory, loadMoreHistory,
    awaitingDecision, submitDecision,
  };
}
