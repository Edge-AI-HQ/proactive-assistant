import { proxyFetch, proxyPost } from "../transport/http";
import { resolveClientHints } from "../transport/config";
import { proxyGetSSE } from "../transport/sse";

// ── Conversation history shapes ──
//    Persisted-turn types for the unified /api/conversation/* history (main /
//    card / proactive). RC-5 removed the standalone /api/proactive/* client;
//    these types now back ConversationHistoryPage.messages.

export interface ConversationHistoryToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  status: "running" | "ok" | "error";
  meta?: string;
  argsPreview?: string;
  pinCommand?: string;
  args?: unknown;
  /** Subagent attribution: the `task` tool-call id this nested call belongs
   *  to. Absent on the orchestrator's own calls — renderer falls back to the
   *  flat stream. */
  parentTaskId?: string;
  agentName?: string;
  /** Async LLM title backfilled onto a work group's first tool-call part. */
  groupTitle?: string;
  /** Structured sources from web-search tools (favicon+title rows). */
  links?: { title: string; url: string }[];
}

export type ConversationHistoryPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | ConversationHistoryToolCallPart;

export interface ConversationHistoryMessage {
  id: string;
  role: "user" | "assistant";
  parts: ConversationHistoryPart[];
  createdAt?: number;
  /** User turns only: the client message id the send carried (clientMsgId on
   *  POST /send), echoed back so the optimistic bubble reconciles by identity
   *  instead of text. Absent on assistant rows, pre-089 rows, and sends that
   *  didn't supply one. */
  clientMsgId?: string;
}

// ── Conversation agent (unified actor kernel: /api/conversation/*) ──
//    RC-5: one client for main / card / proactive chat, replacing the
//    /api/chat-stream/* (main+card) and /api/proactive/* (proactive) clients.
//    The reply is async — it arrives on conversationStream(), not the send
//    response; HITL pauses surface as chat:requires_action frames resolved by
//    conversationDecision().

export interface ConversationInitResult {
  sessionKey: string;
  kind: "main" | "card";
  existing: boolean;
}

/** Resolve a conversation session_key + whether it already has history. Omit
 *  both hints for the main-chat singleton; pass `cardId` for a card thread's
 *  first open; pass an explicit `sessionKey` to resume a known thread. */
export async function conversationInit(opts?: {
  sessionKey?: string;
  cardId?: string;
  kind?: "main" | "card";
  signal?: AbortSignal;
}): Promise<ConversationInitResult> {
  const body: Record<string, unknown> = {};
  if (opts?.sessionKey) body.session_key = opts.sessionKey;
  if (opts?.cardId) body.card_id = opts.cardId;
  if (opts?.kind) body.kind = opts.kind;
  const res = await proxyPost("/conversation/init", body, opts?.signal);
  if (!res.ok) throw new Error(`/conversation/init failed: ${res.status}`);
  const data = (await res.json()) as Partial<ConversationInitResult>;
  return {
    sessionKey: data.sessionKey ?? "",
    kind: data.kind ?? "main",
    existing: !!data.existing,
  };
}

/** Enqueue a user message onto the session mailbox (202). The reply arrives
 *  over conversationStream(). `cardContext` rides along for a card / feedback
 *  turn (chat injects it as a <card_context> SystemMessage). */
export async function conversationSend(
  sessionKey: string,
  message: string,
  opts?: {
    cardContext?: Record<string, unknown>;
    /** Client-generated message id (crypto.randomUUID). The backend uses it
     *  as the mailbox idempotency key (a retried POST can't enqueue twice)
     *  and echoes it on /history rows + `active.userEntries` so the
     *  optimistic bubble reconciles by identity. Reuse the SAME id when
     *  retrying a failed send. */
    clientMsgId?: string;
    /** Cancel the current in-flight run and make this message the next user
     *  input. Used by queued-message "send now". */
    interrupt?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  const body: Record<string, unknown> = { session_key: sessionKey, message };
  if (opts?.cardContext) body.cardContext = opts.cardContext;
  if (opts?.clientMsgId) body.clientMsgId = opts.clientMsgId;
  if (opts?.interrupt) body.interrupt = true;
  // Display device hints for the remote browser (viewport + mobile/desktop
  // UA). Platform-injected; null when unconfigured / no probe — never throws.
  const clientHints = resolveClientHints();
  if (clientHints) body.clientHints = clientHints;
  const res = await proxyPost("/conversation/send", body, opts?.signal);
  if (!res.ok) throw new Error(`/conversation/send failed: ${res.status}`);
}

export async function conversationUpdateMessage(
  sessionKey: string,
  clientMsgId: string,
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await proxyFetch("/conversation/message", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_key: sessionKey,
      clientMsgId,
      message,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`/conversation/message PATCH failed: ${res.status}`);
}

export async function conversationDeleteMessage(
  sessionKey: string,
  clientMsgId: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await proxyFetch("/conversation/message", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_key: sessionKey,
      clientMsgId,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`/conversation/message DELETE failed: ${res.status}`);
}

/** HITL: resolve a paused tool call (a chat:requires_action frame). The
 *  decision rides back through the mailbox + resumes the run via
 *  Command(resume=). `toolUseId` is the frame's `interruptId`. */
export async function conversationDecision(
  sessionKey: string,
  toolUseId: string,
  decision: "approve" | "reject" | "edit" | "respond",
  opts?: { message?: string; signal?: AbortSignal },
): Promise<void> {
  const body: Record<string, unknown> = {
    session_key: sessionKey,
    toolUseId,
    decision,
  };
  if (opts?.message !== undefined) body.message = opts.message;
  const res = await proxyPost("/conversation/decision", body, opts?.signal);
  if (!res.ok) throw new Error(`/conversation/decision failed: ${res.status}`);
}

/** Stop the session's in-flight turn (idempotent — no-op if nothing runs). */
export async function conversationCancel(
  sessionKey: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await proxyPost(
    "/conversation/cancel",
    { session_key: sessionKey },
    signal,
  );
  if (!res.ok) throw new Error(`/conversation/cancel failed: ${res.status}`);
}

/** Long-lived, resumable push stream of a session's frames (SSE envelopes):
 *  thinking / reasoning / tool / text / requires_action.
 *  Iterate until it ends, then reconnect — passing the last `lastEventId` seen
 *  so the server replays the frames missed during the gap (no loss, no dup).
 *  Yields `{ event, lastEventId }`. */
export function conversationStream<T = unknown>(
  sessionKey: string,
  signal?: AbortSignal,
  lastEventId?: string | null,
): AsyncGenerator<{ event: T; lastEventId: string | null }> {
  const params = new URLSearchParams({ session: sessionKey });
  if (lastEventId) params.set("lastEventId", lastEventId);
  return proxyGetSSE<T>(`/conversation/stream?${params.toString()}`, signal);
}

/** Options for {@link conversationHistory}. */
export interface ConversationHistoryOpts {
  signal?: AbortSignal;
  /** Load-older cursor: a row id; returns entries strictly older than it. */
  before?: number;
  /** Page size. Backend caps at 200; default 50. */
  limit?: number;
}

/** A paused HITL run surfaced on the newest history page so the FE can rebuild
 *  the approval gate after a refresh / reconnect (the live /stream never replays
 *  the requires_action frame). Same shape the live frame carries. */
export interface ConversationAwaiting {
  toolUseId: string;
  toolName: string;
  argsPreview?: string;
  /** Structured tool input (mirrors the live frame's `args`) so a card rebuilt
   *  from history after a refresh humanizes the same as the live one. */
  args?: Record<string, unknown>;
  allowedDecisions: string[];
  /** Reasoning / tool-call parts the agent streamed before the interrupt (not
   *  yet persisted — they land on resume). Same shape as a history message's
   *  parts; the FE redraws the in-progress turn above the gate on refresh. */
  partialParts: ConversationHistoryPart[];
}

/** One in-flight input as the server sees it (an unconsumed mailbox row).
 *  `clientId` is the send's clientMsgId (null for sends that carried none),
 *  letting the FE reconcile against its optimistic bubble by identity. */
export interface ConversationActiveEntry {
  text: string;
  clientId: string | null;
  /** True when this input is waiting behind an already-running agent turn. */
  queued?: boolean;
}

/** The in-flight turn, surfaced on the newest page so a REFRESH mid-turn can
 *  rebuild it — it isn't in pai_chat_messages until it finishes. `userTexts`
 *  are the user bubble(s) to render (from the unconsumed mailbox; empty for a
 *  regenerate, which reuses the existing bubble). `replayFrom` is the stream
 *  cursor to open /stream from so the agent's frames replay and rebuild the
 *  assistant bubble; null when the turn hasn't produced frames yet (just
 *  sent — the live tail carries them). */
export interface ConversationActive {
  userTexts: string[];
  /** Same list as `userTexts` with each input's client message id. Optional
   *  while older backends may omit it — fall back to `userTexts`. */
  userEntries?: ConversationActiveEntry[];
  replayFrom: string | null;
}

/** One page of a session's persisted turns (pai_chat_messages), oldest-first.
 *  `nextCursor` is the id to pass back as `before` for the next older page
 *  (null when no more). `awaiting` is set only on the newest page (no `before`)
 *  when a HITL run is paused. Reuses the proactive history message shape. */
export interface ConversationHistoryPage {
  messages: ConversationHistoryMessage[];
  nextCursor: number | null;
  awaiting: ConversationAwaiting | null;
  /** Non-null only on the newest page (no `before`) when a turn is mid-flight. */
  active: ConversationActive | null;
}

export async function conversationHistory(
  sessionKey: string,
  opts: ConversationHistoryOpts = {},
): Promise<ConversationHistoryPage> {
  const params = new URLSearchParams({ session: sessionKey });
  if (opts.before !== undefined) params.set("before", String(opts.before));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const res = await proxyFetch(`/conversation/history?${params.toString()}`, {
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`/conversation/history failed: ${res.status}`);
  const data = (await res.json()) as {
    messages?: ConversationHistoryMessage[];
    nextCursor?: number | null;
    awaiting?: ConversationAwaiting | null;
    active?: ConversationActive | null;
  };
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    nextCursor: data.nextCursor ?? null,
    awaiting: data.awaiting ?? null,
    active: data.active ?? null,
  };
}
