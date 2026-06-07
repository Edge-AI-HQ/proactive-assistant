/**
 * Runtime hook for the per-user **proactive agent**.
 *
 * Unlike a request→response per-turn runtime adapter,
 * the proactive agent is a single continuous server-driven loop: every ~30s
 * the backend feeds it a heartbeat (current time + new timeline events) and
 * the agent decides whether to think / use tools / message the user. Turns
 * therefore arrive UNSOLICITED over a long-lived push stream — there is no
 * "send → wait for this send's reply" coupling. The user can also message it;
 * that reply also comes back over the stream, not in the POST response.
 *
 * Because of the push model we can't reuse a per-turn runtime adapter (its `run()`
 * is invoked per user turn). Instead we keep a plain React-state transcript and
 * reuse `LiveContentBuilder` (the same machinery main chat uses) to accumulate
 * each streaming turn's ordered parts, finalizing into the transcript on
 * `chat:done`.
 *
 * Wire contract (backend, already built). `?session=` is omitted for the
 * user's main thread and set to `card-thread-<id>` for a card thread:
 *   GET  /api/conversation/history → { messages: [{ id, role, parts: [...] }] }
 *   GET  /api/conversation/stream  → long-lived SSE: `data: {envelope}\n\n`
 *                                     + `: keepalive` comment lines.
 *   POST /api/conversation/send    → 202 { ok: true } (reply arrives on /stream)
 *
 * SSE envelope: { type, ts, traceId?, data }. Event types:
 *   proactive:tick           → heartbeat input fed to the agent (system entry)
 *   chat:thinking            → turn open signal (empty)
 *   chat:reasoning:delta     → { delta } extended thinking
 *   chat:delta               → { delta } visible assistant text
 *   chat:tool:start          → { toolCallId, name, argsPreview, args? }
 *                              name === "notify_user" IS the agent's message
 *   chat:tool:result         → { toolCallId, isError, meta }
 *   chat:done                → finalize current turn
 *   chat:error               → { error }
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  conversationCancel,
  conversationDecision,
  conversationHistory,
  conversationSend,
  conversationStream,
  fetchProactiveEnabled,
  setProactiveEnabled,
  type ConversationHistoryMessage,
} from "@/lib/api";
import {
  LiveContentBuilder,
  type JsonValue,
  type ConversationContentPart,
} from "@/components/chat/conversation/tool-steps";
import { parseTodosFromArgs, setTodos, type Todo } from "@/components/chat/conversation/todos-store";
import type { HitlRequiresAction } from "@/components/chat/conversation/HitlApprovalCard";


export type ConversationConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface ConversationHeartbeatEntry {
  kind: "heartbeat";
  id: string;
  ts: number;
  text: string;
  windowStart: string | null;
  windowEnd: string;
}

export interface ConversationUserEntry {
  kind: "user";
  id: string;
  ts: number;
  text: string;
  /** True when the `/send` POST failed. The bubble shows a retry affordance;
   *  cleared on a successful resend. Failed bubbles are never in server
   *  history, so they're preserved across reconnect resync. */
  failed?: boolean;
}

export interface ConversationAssistantEntry {
  kind: "assistant";
  id: string;
  ts: number;
  /** Ordered content parts (text / reasoning / tool-call), exactly the shape
   *  main chat's renderers consume. */
  parts: ConversationContentPart[];
  /** True while this turn is still streaming (before chat:done). Drives the
   *  shimmer / "Thinking…" affordance the same way main chat does. */
  running: boolean;
  /** True when this turn was triggered by a heartbeat tick (vs a user
   *  message). The UI treats it as debug — hidden unless Debug is on, except
   *  any `notify_user` part, which always shows. */
  debug?: boolean;
}

export type ConversationEntry =
  | ConversationHeartbeatEntry
  | ConversationUserEntry
  | ConversationAssistantEntry;

interface SseEnvelope {
  type: string;
  ts?: number;
  traceId?: string;
  data?: Record<string, unknown>;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/** Page size for the initial history fetch + each "load older" page on
 *  scroll-up. Backend caps at 500; this is a comfortable screenful or two
 *  of debug-on heartbeats. */
const HISTORY_PAGE_SIZE = 200;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Does this assistant turn already contain a `notify_user` tool call?
 *  Used to keep a tick-triggered turn visible to the user even when the
 *  Debug toggle is off — the notify_user is exactly the part they're
 *  meant to see. Mirrors the backend `_is_debug_only` rule one-for-one.
 *  Exported for parity-testing against the backend filter. */
export function partsHaveNotifyUser(parts: ConversationContentPart[]): boolean {
  return parts.some(
    (p) => p.type === "tool-call" && p.toolName === "notify_user",
  );
}

function historyText(m: ConversationHistoryMessage): string {
  return m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

function historyAssistantParts(m: ConversationHistoryMessage): ConversationContentPart[] {
  return m.parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "reasoning") return { type: "reasoning", text: p.text };
    const args: { [k: string]: JsonValue } = { status: p.status };
    if (p.meta) args.meta = p.meta;
    if (p.argsPreview) args.argsPreview = p.argsPreview;
    if (p.pinCommand) args.pinCommand = p.pinCommand;
    if (p.args !== undefined) args.input = p.args as JsonValue;
    const part: ConversationContentPart = {
      type: "tool-call",
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      args,
      argsText: JSON.stringify(args),
    };
    if (p.status !== "running") {
      part.result = { ok: p.status === "ok" };
      if (p.status === "error") part.isError = true;
    }
    return part;
  });
}

/** Convert persisted history into transcript entries, classifying which
 *  assistant turns are heartbeat-triggered (debug) so reload/reconnect matches
 *  the live view.
 *
 *  A heartbeat INPUT is recognized two ways, so this works regardless of
 *  backend version: role `heartbeat` (updated backend) OR a `[heartbeat]`
 *  text prefix on a `user` message (older backend that emits the heartbeat as
 *  a plain user turn). The assistant turn that FOLLOWS a heartbeat input is
 *  debug — taken from the backend's `trigger` when present, else inferred from
 *  the preceding heartbeat. */
export function historyToEntries(
  messages: ConversationHistoryMessage[],
): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  let lastInputWasTick = false;
  for (const m of messages) {
    const ts = typeof m.createdAt === "number" ? m.createdAt : Date.now();
    const isHeartbeatInput =
      m.role === "heartbeat" ||
      (m.role === "user" && historyText(m).trimStart().startsWith("[heartbeat]"));
    if (isHeartbeatInput) {
      lastInputWasTick = true;
      out.push({ kind: "heartbeat", id: m.id, ts, text: historyText(m), windowStart: null, windowEnd: "" });
      continue;
    }
    if (m.role === "user") {
      lastInputWasTick = false;
      out.push({ kind: "user", id: m.id, ts, text: historyText(m) });
      continue;
    }
    out.push({
      kind: "assistant",
      id: m.id,
      ts,
      parts: historyAssistantParts(m),
      running: false,
      debug: m.trigger === "tick" || lastInputWasTick,
    });
  }
  return out;
}

/** Find the most recent `write_todos` plan in persisted history so the
 *  TodoPanel can be re-hydrated after a page refresh (the live store is
 *  module-level and wiped on reload; the plan itself lives in history). */
function latestTodosFromHistory(
  messages: ConversationHistoryMessage[],
): Todo[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p.type === "tool-call" && p.toolName === "write_todos") {
        const todos = parseTodosFromArgs(p.args);
        if (todos) return todos;
      }
    }
  }
  return null;
}

let entrySeq = 0;
function nextEntryId(prefix: string): string {
  entrySeq += 1;
  return `${prefix}-${Date.now()}-${entrySeq}`;
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
  /** When true, fetch the debug-visible history (heartbeats + silent
   *  tick-triggered turns) and let live heartbeat events through.
   *  When false (default), the backend filters those out at the source
   *  and the live stream is gated locally so transcript stays clean.
   *  Flipping this triggers a full history refetch + stream reconnect. */
  debugEnabled?: boolean;
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
  // Plan parsed from history on (re)connect; applied to the todo store once
  // the thread id is known (the main thread's id resolves at the stream hello).
  const pendingTodosRef = useRef<Todo[] | null>(null);
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
  // Cached index of the current turn's entry in the transcript array, so a
  // per-delta flush is O(1) instead of scanning the whole transcript every
  // token. Other appends (ticks / user messages) always go to the end and
  // never shift this entry; a transcript trim does, so flushTurn revalidates
  // the cached index and re-finds it on a miss.
  const turnPosRef = useRef(-1);

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
  }, [flushTurn]);

  const handleEnvelope = useCallback(
    (env: SseEnvelope) => {
      const payload = env.data ?? {};
      // Classify the turn being assembled: a chat:* event whose traceId we saw
      // on a proactive:tick belongs to a heartbeat-triggered (debug) turn. All
      // a turn's events share one traceId, so this is stable within a turn.
      if (env.type.startsWith("chat:") && env.traceId) {
        turnDebugRef.current = tickRunIdsRef.current.has(env.traceId);
      }
      switch (env.type) {
        case "conversation:hello": {
          // Confirm the server-resolved session id so the browser live view +
          // todo store can be keyed to this thread.
          const tid = str(payload.sessionKey);
          if (tid) {
            threadIdRef.current = tid;
            setThreadId(tid);
            // Apply any plan re-hydrated from history now that we can key it.
            if (pendingTodosRef.current) setTodos(tid, pendingTodosRef.current);
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
          // write_todos feeds the side-panel plan store (keyed by thread id),
          // exactly as the old main-chat runtime did — the tool chip still
          // renders too, but the structured plan drives TodoPanel.
          if (name === "write_todos" && threadIdRef.current) {
            const todos = parseTodosFromArgs(payload.args);
            if (todos) setTodos(threadIdRef.current, todos);
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
          });
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
          break;
        }
        case "chat:done": {
          finalizeTurn();
          setBusy(false);
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

    const connect = async () => {
      if (cancelled) return;
      abort = new AbortController();
      const signal = abort.signal;

      // Resync from history on every (re)connect so a dropped stream can't
      // leave the transcript missing turns that landed while we were gone.
      // We fetch the newest page (`before` omitted); older pages load lazily
      // via `loadMoreHistory` when the user scrolls up. `includeDebug` is
      // taken from the current prop value so a debug-toggle re-runs this
      // effect and pulls the matching filtered view.
      try {
        const page = await conversationHistory(session, {
          signal,
          limit: HISTORY_PAGE_SIZE,
          includeDebug: debugEnabled,
        });
        if (cancelled) return;
        const history = historyToEntries(page.messages);
        // Redraw the in-progress (paused) assistant turn above the gate so a
        // refresh doesn't look like it wiped the thinking / tool calls streamed
        // before the interrupt. partialParts aren't persisted yet (they land on
        // resume); the awaiting payload carries them. running:true → it renders
        // inline without an action bar, matching the live interrupt view.
        if (page.awaiting?.partialParts?.length) {
          const [partial] = historyToEntries([
            {
              id: `partial-${page.awaiting.toolUseId}`,
              role: "assistant" as const,
              parts: page.awaiting.partialParts,
            },
          ]);
          if (partial?.kind === "assistant") {
            history.push({ ...partial, running: true });
          }
        }
        // Re-hydrate the plan panel from history so a page refresh doesn't
        // blank it. Applied now if the thread id is already known (card
        // session); otherwise stashed and applied on the stream hello.
        pendingTodosRef.current = latestTodosFromHistory(page.messages);
        if (pendingTodosRef.current && threadIdRef.current) {
          setTodos(threadIdRef.current, pendingTodosRef.current);
        }
        // Discard any half-streamed turn; history is the source of truth for
        // assistant turns.
        builderRef.current = null;
        turnIdRef.current = null;
        turnPosRef.current = -1;
        // …but DON'T drop user messages that history doesn't yet reflect: a
        // just-sent bubble (POST in flight / persisted moments ago) or a
        // failed send. Carrying them over keeps the user's own message from
        // blinking out on reconnect/refresh. Dedup by trimmed text against
        // history's user turns so a confirmed message isn't duplicated.
        setTranscript((prev) => {
          const historyUserText = new Set(
            history.flatMap((e) => (e.kind === "user" ? [e.text.trim()] : [])),
          );
          const carry = prev.filter(
            (e) =>
              e.kind === "user" &&
              (e.failed || !historyUserText.has(e.text.trim())),
          );
          return [...history, ...carry];
        });
        // Note: we deliberately do NOT seed `tickRunIdsRef` from history.
        // That set is keyed by SSE `traceId` (= run_id, format
        // `proactive.<user>.<rand>` from proactive_loop), which is a
        // DIFFERENT identifier from a history entry's AIMessage id (LangChain
        // `lc_run--<uuid>`). Live chat events always arrive after their tick
        // (`proactive:tick` registers the run_id first), so classification
        // works from scratch on every reconnect without backfill.
        setHasMoreHistory(page.nextCursor !== null);
        oldestCursorRef.current = page.nextCursor;
        // Rebuild (or clear) the HITL approval gate from the server's current
        // run state: /stream is live-only and won't replay requires_action, so a
        // refresh / reconnect relies on this to restore a paused gate. Only the
        // decision fields go into the gate (partialParts above already redrew the
        // in-progress turn), matching the live requires_action shape.
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
        setBusy(false);
        setReady(true);
      } catch (err) {
        if (cancelled || signal.aborted) return;
        // History failed — keep whatever we have and still try the stream.
        setReady(true);
        console.warn("[proactive] history fetch failed:", err);
      }

      if (cancelled) return;
      setConnection(attempt === 0 ? "connecting" : "reconnecting");

      // The backend emits an initial `proactive:hello` event on connect, so
      // the first yield flips us to "open" (and resets backoff) even when the
      // stream is otherwise idle. SSE parsing + keepalive handling live in
      // the api layer's proxyGetSSE.
      try {
        let opened = false;
        for await (const env of conversationStream<SseEnvelope>(session, signal)) {
          if (cancelled) return;
          if (!opened) {
            opened = true;
            setConnection("open");
            attempt = 0;
          }
          handleEnvelope(env);
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
    async (id: string, text: string) => {
      // Awaiting a turn from here on → composer flips to Stop + gates sends
      // immediately, before the (possibly slow first-turn) stream even starts.
      setBusy(true);
      setAwaitingDecision(null); // a new message supersedes any pending approval
      // card_context (if any) rides only the first send, then is cleared —
      // but only after the send succeeds, so a failed first send retries with it.
      const cardContext = cardCtxRef.current ?? undefined;
      try {
        await conversationSend(session, text, { cardContext });
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
        setTranscript((prev) =>
          prev.map((e) =>
            e.kind === "user" && e.id === id ? { ...e, failed: true } : e,
          ),
        );
      }
    },
    [session],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Optimistic: the reply does NOT come back on this POST — it arrives over
      // /stream — so we render the user's message locally immediately.
      const id = nextEntryId("user");
      setTranscript((prev) => [
        ...prev,
        { kind: "user", id, ts: Date.now(), text: trimmed },
      ]);
      await postUserMessage(id, trimmed);
    },
    [postUserMessage],
  );

  const retryMessage = useCallback(
    async (id: string, text: string) => {
      setTranscript((prev) =>
        prev.map((e) =>
          e.kind === "user" && e.id === id ? { ...e, failed: false } : e,
        ),
      );
      await postUserMessage(id, text);
    },
    [postUserMessage],
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
    setBusy(true);
    setAwaitingDecision(null);
    try {
      await conversationSend(session, lastUserText, { regenerate: true });
    } catch (err) {
      console.warn("[proactive] regenerate failed:", err);
      setBusy(false);
    }
  }, [busy, transcript, session]);

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
