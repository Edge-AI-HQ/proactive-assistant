/**
 * Runtime hook for the per-user **proactive agent**（分层 Phase 3c）。
 *
 * 纯逻辑（history→entries 转换、heartbeat 分类、resync 三段合并、HITL
 * partial 重建）在 @pin-ai/core 的 machines/conversation.ts（回放测试）；
 * LiveContentBuilder（流式 turn 组装）在 core 的 machines/tool-steps.ts。
 * 本文件只剩 React 编排：SSE 长连接生命周期（首连 resync / 游标重连 /
 * capped backoff）、builder 的 ref 桥接与 flush、busy/HITL/heartbeat 开关
 * 等 actions。对外接口与迁移前完全一致（ConversationView 零改动）。
 *
 * Unlike a request→response per-turn runtime adapter, the proactive agent
 * is a single continuous server-driven loop: turns arrive UNSOLICITED over
 * a long-lived push stream（详见 core machines/conversation.ts 头注释与
 * 后端 wire contract）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  awaitingPartialEntry,
  conversationCancel,
  conversationDecision,
  conversationHistory,
  conversationSend,
  conversationStream,
  fetchProactiveEnabled,
  historyToEntries,
  mergeTranscriptOnResync,
  nextEntryId,
  partsHaveNotifyUser,
  parseToolLinks,
  setProactiveEnabled,
  LiveContentBuilder,
  type ConversationAssistantEntry,
  type ConversationConnectionState,
  type ConversationEntry,
  type ConversationHistoryPage,
  type ConversationSseEnvelope,
  type ConversationUserEntry,
  type HitlRequiresAction,
  type JsonValue,
} from "@pin-ai/core";

import { finalizePlanTurn, parseTodosFromArgs, setTodos } from "../stores/todos";

export type {
  ConversationAssistantEntry,
  ConversationConnectionState,
  ConversationEntry,
  ConversationHeartbeatEntry,
  ConversationUserEntry,
} from "@pin-ai/core";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/** Page size for the initial history fetch + each "load older" page on
 *  scroll-up. Backend caps at 500; this is a comfortable screenful or two
 *  of debug-on heartbeats. */
const HISTORY_PAGE_SIZE = 200;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface ConversationRuntimeOpts {
  /** Thread to address. Omit → the user's main thread (heartbeat-capable).
   *  `card-thread-<id>` → a per-card execution thread (no heartbeat). */
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
  /** When true, fetch the debug-visible history (heartbeats + silent
   *  tick-triggered turns) and let live heartbeat events through.
   *  When false (default), the backend filters those out at the source
   *  and the live stream is gated locally so transcript stays clean.
   *  Flipping this triggers a full history refetch + stream reconnect. */
  debugEnabled?: boolean;
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
  /** Regenerate the latest assistant turn: drops it locally and re-runs the
   *  latest user message with regenerate=true (backend pops the stale reply). */
  regenerateLast: () => Promise<void>;
  /** Whether the heartbeat is on. `null` until the initial fetch (main thread
   *  only — stays `null` for card threads, which never heartbeat). */
  enabled: boolean | null;
  /** Turn the heartbeat on/off (optimistic; reconciles with the server). */
  setEnabled: (next: boolean) => Promise<void>;
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
  // heartbeat toggle (listening on/off) only applies to the proactive thread;
  // main + card threads are purely user-driven.
  const isProactive = session.startsWith("proactive-");
  const bootstrap = opts?.bootstrap;
  const debugEnabled = !!opts?.debugEnabled;
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
  // The latest debugEnabled value, available to callbacks (flushTurn,
  // loadMoreHistory) without re-creating them on every toggle. The
  // connection lifecycle effect uses the prop value directly so a toggle
  // forces a fresh history fetch + reconnect.
  const debugEnabledRef = useRef(debugEnabled);
  useEffect(() => { debugEnabledRef.current = debugEnabled; }, [debugEnabled]);
  // True while we're awaiting / streaming a user-initiated turn. Set on send,
  // cleared on the turn's chat:done/error (also on stop + reconnect resync).
  // Background heartbeat turns DON'T set it, so the composer doesn't flicker to
  // Stop on every idle tick.
  const [busy, setBusy] = useState(false);
  const [awaitingDecision, setAwaitingDecision] =
    useState<HitlRequiresAction | null>(null);
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  // The card session id is known up front; the main thread id arrives in the
  // stream's hello event. Mirrored into a ref so the SSE handler can key the
  // todo store without re-subscribing.
  const [threadId, setThreadId] = useState<string | null>(session || null);
  const threadIdRef = useRef<string | null>(session || null);
  // run_ids seen on a `proactive:tick` → those runs' chat events form a
  // heartbeat-triggered (debug) turn. Every chat event carries the same
  // traceId (=run_id), so a turn whose traceId is in this set is debug.
  const tickRunIdsRef = useRef<Set<string>>(new Set());
  // Whether the turn currently being assembled is debug (set per chat event
  // from its traceId; consistent within a turn since all share one run_id).
  const turnDebugRef = useRef(false);

  // The streaming turn currently being assembled from SSE deltas. We keep the
  // builder + its transcript entry id in refs so the SSE loop can fold deltas
  // without re-subscribing, then flush to React state on each change.
  const builderRef = useRef<LiveContentBuilder | null>(null);
  const turnIdRef = useRef<string | null>(null);
  // The send-time optimistic placeholder's turn id while it's still UNCLAIMED
  // (no user-turn frame has adopted it). See createTurnPlaceholder.
  const placeholderTurnIdRef = useRef<string | null>(null);
  // Cached index of the current turn's entry in the transcript array, so a
  // per-delta flush is O(1) instead of scanning the whole transcript every
  // token. Other appends (ticks / user messages) always go to the end and
  // never shift this entry; a transcript trim does, so flushTurn revalidates
  // the cached index and re-finds it on a miss.
  const turnPosRef = useRef(-1);
  // SSE resume cursor: the Redis Stream entry id of the last frame received.
  // Echoed back as Last-Event-ID on reconnect so the server replays the frames
  // missed during the gap (vs the old no-replay model that lost them). Null =
  // a fresh connection cycle → rebuild from history + tail from now.
  const lastEventIdRef = useRef<string | null>(null);

  // Push the in-progress assistant turn's snapshot into the transcript. If the
  // turn entry doesn't exist yet it's appended; otherwise its parts are
  // replaced in place. `running` controls the shimmer affordance.
  //
  // Debug gate: when Debug is off, a tick-triggered turn stays invisible
  // UNTIL it produces a `notify_user` — silent thinking / non-notify tool
  // calls in a heartbeat turn are the agent's private scratchpad and the
  // user shouldn't see them appearing then disappearing. Mirrors the
  // backend `_is_debug_only` filter for live events.
  const flushTurn = useCallback((running: boolean) => {
    const builder = builderRef.current;
    const turnId = turnIdRef.current;
    if (!builder || !turnId) return;
    const parts = builder.snapshot();
    if (
      !debugEnabledRef.current
      && turnDebugRef.current
      && !partsHaveNotifyUser(parts)
    ) {
      return;
    }
    setTranscript((prev) => {
      let idx = turnPosRef.current;
      const cached = idx >= 0 && idx < prev.length ? prev[idx] : undefined;
      if (!cached || cached.kind !== "assistant" || cached.id !== turnId) {
        idx = prev.findIndex((e) => e.kind === "assistant" && e.id === turnId);
      }
      if (idx === -1) {
        turnPosRef.current = prev.length;
        return [
          ...prev,
          { kind: "assistant", id: turnId, ts: Date.now(), parts, running, debug: turnDebugRef.current },
        ];
      }
      turnPosRef.current = idx;
      const next = prev.slice();
      const existing = next[idx] as ConversationAssistantEntry;
      next[idx] = { ...existing, parts, running, debug: turnDebugRef.current };
      return next;
    });
  }, []);

  const ensureTurn = useCallback(() => {
    if (!builderRef.current) builderRef.current = new LiveContentBuilder();
    if (!turnIdRef.current) {
      turnIdRef.current = nextEntryId("turn");
      turnPosRef.current = -1;
    }
  }, []);

  const finalizeTurn = useCallback(() => {
    if (turnIdRef.current && builderRef.current) {
      // If the builder produced no visible parts (silent heartbeat), drop the
      // empty entry rather than leaving a blank bubble.
      if (builderRef.current.isEmpty()) {
        const turnId = turnIdRef.current;
        setTranscript((prev) =>
          prev.filter((e) => !(e.kind === "assistant" && e.id === turnId)),
        );
      } else {
        flushTurn(false);
      }
    }
    builderRef.current = null;
    turnIdRef.current = null;
    turnPosRef.current = -1;
    placeholderTurnIdRef.current = null;
  }, [flushTurn]);

  // Optimistic turn placeholder: open the assistant entry (whose in-entry
  // "Thinking…" pill shows while parts are empty) the moment the user sends,
  // so the reply slot exists immediately — the send anchor scrolls against it
  // and the pill never pops in later. The real turn's frames continue into
  // the same builder (ensureTurn is idempotent). Skipped when a foreign turn
  // (heartbeat tick) is mid-stream — that builder isn't ours to reuse; the
  // send's turn opens via its own chat:thinking after it.
  //
  // `placeholderTurnIdRef` marks the placeholder as UNCLAIMED until a
  // user-turn frame adopts it. A tick turn that starts only after the send
  // must not adopt it either — the debug gate would then swallow every flush
  // and strand the entry as an eternal running/empty pill. The classifier in
  // handleEnvelope drops a still-idle placeholder the moment a debug frame
  // shows up, so the tick opens its own (gated) turn instead.
  const createTurnPlaceholder = useCallback((): string | null => {
    if (builderRef.current) return null;
    turnDebugRef.current = false; // user-initiated — never a debug turn
    ensureTurn();
    flushTurn(true);
    placeholderTurnIdRef.current = turnIdRef.current;
    return turnIdRef.current;
  }, [ensureTurn, flushTurn]);

  // Drop a still-empty placeholder (send failed / nothing ever streamed into
  // it). Guarded so a real turn that already adopted the builder is untouched.
  const dropIdlePlaceholder = useCallback(
    (placeholderId: string | null) => {
      if (!placeholderId) return;
      if (turnIdRef.current === placeholderId && builderRef.current?.isEmpty()) {
        finalizeTurn();
      }
    },
    [finalizeTurn],
  );

  const handleEnvelope = useCallback(
    (env: ConversationSseEnvelope) => {
      const payload = env.data ?? {};
      // Classify the turn being assembled: a chat:* event whose traceId we saw
      // on a proactive:tick belongs to a heartbeat-triggered (debug) turn. All
      // a turn's events share one traceId, so this is stable within a turn.
      if (env.type.startsWith("chat:") && env.traceId) {
        turnDebugRef.current = tickRunIdsRef.current.has(env.traceId);
        if (turnDebugRef.current) {
          // A tick turn opening against an unclaimed send placeholder: drop
          // the placeholder (still empty → finalizeTurn deletes the entry)
          // so the tick builds its own turn and the debug gate can't strand
          // a running/empty entry. The user turn re-opens via its own
          // chat:thinking afterwards.
          if (
            placeholderTurnIdRef.current !== null
            && placeholderTurnIdRef.current === turnIdRef.current
            && builderRef.current?.isEmpty()
          ) {
            finalizeTurn();
          }
        } else {
          placeholderTurnIdRef.current = null; // claimed by the user turn
        }
      }
      switch (env.type) {
        case "conversation:hello": {
          // Confirm the server-resolved session id so the browser live view +
          // todo store can be keyed to this thread.
          const tid = str(payload.sessionKey);
          if (tid) {
            threadIdRef.current = tid;
            setThreadId(tid);
          }
          break;
        }
        case "proactive:tick": {
          // Always remember this run as a heartbeat turn so its chat events
          // (same traceId) get classified debug — even when Debug is off, the
          // classification is what gates the tick turn's `flushTurn`.
          if (env.traceId) tickRunIdsRef.current.add(env.traceId);
          // Heartbeat input entries are debug-only. When Debug is off we
          // drop them at the source so the transcript stays clean (mirrors
          // the backend filter for live events).
          if (!debugEnabledRef.current) break;
          const text = str(payload.text);
          const windowEnd = str(payload.windowEnd);
          const windowStart =
            typeof payload.windowStart === "string"
              ? payload.windowStart
              : null;
          setTranscript((prev) => [
            ...prev,
            {
              kind: "heartbeat",
              id: nextEntryId("tick"),
              ts: typeof env.ts === "number" ? env.ts : Date.now(),
              text,
              windowStart,
              windowEnd,
            },
          ]);
          break;
        }
        case "chat:thinking": {
          // Turn open signal — start a fresh assistant turn so the
          // "Thinking…" shimmer shows before the first delta lands.
          ensureTurn();
          flushTurn(true);
          break;
        }
        case "chat:reasoning:delta": {
          const delta = str(payload.delta);
          if (!delta) break;
          ensureTurn();
          builderRef.current!.appendReasoning(delta);
          flushTurn(true);
          break;
        }
        case "chat:delta": {
          const delta = str(payload.delta);
          if (!delta) break;
          ensureTurn();
          builderRef.current!.appendText(delta);
          flushTurn(true);
          break;
        }
        case "chat:tool:start": {
          const toolCallId = str(payload.toolCallId);
          const name = str(payload.name);
          if (!toolCallId || !name) break;
          // write_todos feeds the side-panel plan store (keyed by thread id,
          // scoped to this turn via traceId) — the tool chip still renders
          // too, but the structured plan drives TodoPanel. The backend only
          // streams the orchestrator's own write_todos (subagent plans are
          // suppressed at the SSE layer), so no source check is needed here.
          if (name === "write_todos" && threadIdRef.current) {
            const todos = parseTodosFromArgs(payload.args);
            if (todos) setTodos(threadIdRef.current, todos, str(env.traceId));
          }
          // All tools — including notify_user — flow through as tool-call parts,
          // matching the history-replay path (historyAssistantParts maps them
          // the same way). The renderer special-cases notify_user into its own
          // card; plain agent text still arrives via chat:delta.
          ensureTurn();
          builderRef.current!.openToolCall({
            toolCallId,
            toolName: name,
            argsPreview: str(payload.argsPreview) || undefined,
            parentTaskId: str(payload.parentTaskId) || undefined,
            agentName: str(payload.agentName) || undefined,
            input: payload.args as JsonValue | undefined,
          });
          flushTurn(true);
          break;
        }
        case "chat:tool:result": {
          const toolCallId = str(payload.toolCallId);
          if (!toolCallId || !builderRef.current) break;
          builderRef.current.completeToolCall({
            toolCallId,
            isError: Boolean(payload.isError),
            meta: str(payload.meta) || undefined,
            links: parseToolLinks(payload.links),
          });
          flushTurn(true);
          break;
        }
        case "chat:group:title": {
          // Async annotation for a closed work group — backfilled onto the
          // anchor tool-call part (same rule as the backend recorder), so
          // live rendering matches the persisted history.
          const anchor = str(payload.anchorToolCallId);
          const title = str(payload.title);
          if (!anchor || !title || !builderRef.current) break;
          builderRef.current.setGroupTitle(anchor, title);
          flushTurn(true);
          break;
        }
        case "chat:requires_action": {
          // HITL: the turn paused on a side-effect tool. Keep the partial turn
          // visible (flushed running), surface the approval, and clear busy so
          // the composer isn't stuck on Stop while we wait for the human.
          const interruptId = str(payload.interruptId);
          if (!interruptId) break;
          flushTurn(true);
          const rawAllowed = payload.allowedDecisions;
          setAwaitingDecision({
            toolUseId: interruptId,
            toolName: str(payload.toolName) || "tool",
            argsPreview: str(payload.argsPreview) || undefined,
            allowedDecisions: Array.isArray(rawAllowed)
              ? rawAllowed.map((x) => str(x))
              : [],
          });
          setBusy(false);
          // HITL pause settles the turn for the card layer too — the card
          // should flip to needs_input now, not on the next 30s poll.
          onTurnDoneRef.current?.();
          break;
        }
        case "chat:done": {
          finalizeTurn();
          // Retire this turn's plan (turn-scoped todos): the panel shows its
          // done beat and hides; the next turn's write_todos starts fresh.
          if (threadIdRef.current) {
            finalizePlanTurn(threadIdRef.current, str(env.traceId));
            onTurnPersistedRef.current?.(threadIdRef.current);
          }
          setBusy(false);
          onTurnDoneRef.current?.();
          break;
        }
        case "chat:persisted": {
          // Backend persisted this turn's assistant message — adopt the real
          // pai_chat_messages id so thumbs / feedback can join on it (a live
          // turn's id was a client-local "turn-N" until now; history turns
          // already load with the real id). Arrives just after chat:done, so
          // patch the most recent assistant entry (finalizeTurn already closed
          // it).
          const mid = str(payload.messageId);
          if (!mid) break;
          if (threadIdRef.current) {
            onTurnPersistedRef.current?.(threadIdRef.current);
          }
          setTranscript((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].kind === "assistant") {
                if (prev[i].id === mid) return prev;
                const next = [...prev];
                next[i] = { ...(next[i] as ConversationAssistantEntry), id: mid };
                return next;
              }
            }
            return prev;
          });
          break;
        }
        case "chat:error": {
          // Surface the error as a finalized assistant text part, then close
          // the turn so the next heartbeat starts clean.
          const errMsg = str(payload.error) || "Proactive agent error";
          ensureTurn();
          builderRef.current!.appendText(`\n\n_Error: ${errMsg}_`);
          finalizeTurn();
          setBusy(false);
          break;
        }
        default:
          break;
      }
    },
    [ensureTurn, flushTurn, finalizeTurn],
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
            includeDebug: debugEnabled,
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
          // Note: we deliberately do NOT seed `tickRunIdsRef` from history —
          // it's keyed by SSE traceId (run_id), a different identifier from a
          // history entry's AIMessage id. Live events arrive after their tick
          // (which registers the run_id first), so classification works from
          // scratch on every reconnect without backfill.
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
        console.warn("[proactive] stream error:", err);
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
    // `debugEnabled` is a dep so a toggle aborts the current stream + re-runs
    // history fetch with the matching `include_debug` filter, then reopens
    // the stream. Reset + refetch is intentional UX (vs incremental merge):
    // toggle is low-frequency, semantics are unambiguous, and the SSE
    // re-handshake is cheap. Without this the heartbeat / silent-tick rows only
    // ever appear via the live gate and a reconnect would drop them.
  }, [handleEnvelope, session, debugEnabled]);

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
        // Older pages must match the current Debug view, else paging up would
        // mix filtered + unfiltered rows. Read the ref (this callback isn't
        // re-created on toggle; the connect effect already refetches page 1).
        includeDebug: debugEnabledRef.current,
      });
      const olderEntries = historyToEntries(page.messages);
      // (No `tickRunIdsRef` seeding — see note in `connect` above; entry id
      // and SSE `traceId` are different identifiers, so backfilling here
      // would be inert at best and misleading at worst.)
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
      // Optimistic: the reply does NOT come back on this POST — it arrives over
      // /stream — so we render the user's message locally immediately. One
      // uuid serves as entry id AND client message id (clientId), so a retry
      // (which gets the entry id back) naturally reuses the same identity.
      const id = crypto.randomUUID();
      setTranscript((prev) => [
        ...prev,
        { kind: "user", id, ts: Date.now(), text: trimmed, clientId: id },
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

  // Initial on/off state for the toggle — main thread only (cards never
  // heartbeat, so `enabled` stays null and the toggle isn't rendered).
  useEffect(() => {
    if (!isProactive) return;
    const ctrl = new AbortController();
    fetchProactiveEnabled(ctrl.signal)
      .then(setEnabledState)
      .catch(() => {
        /* leave null; toggle stays in its loading state */
      });
    return () => ctrl.abort();
  }, [isProactive]);

  const setEnabled = useCallback(async (next: boolean) => {
    setEnabledState(next); // optimistic
    try {
      const confirmed = await setProactiveEnabled(next);
      setEnabledState(confirmed);
    } catch (err) {
      console.warn("[proactive] toggle failed:", err);
      setEnabledState(!next); // revert
      throw err;
    }
  }, []);

  return {
    transcript, connection, ready, sendMessage, busy, retryMessage, stop,
    regenerateLast,
    enabled, setEnabled, threadId,
    hasMoreHistory, loadMoreHistory,
    awaitingDecision, submitDecision,
  };
}
