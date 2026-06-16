/**
 * Conversation 运行时状态机（纯 TS）—— 分层 Phase 3 从
 * proactive-ai-frontend useConversationRuntime.ts 提纯。
 *
 * 这里是 transcript 的全部纯逻辑：history → entries 转换（heartbeat
 * 分类）、HITL partial 重建、以及 resync 时本地乐观气泡与服务端真相的
 * 三段合并算法（carry / identity / text-claim）。SSE 生命周期编排在
 * @pin-ai/state 的 queries/conversation.ts。回放测试见 conversation.test.ts。
 */
import type {
  ConversationActiveEntry,
  ConversationAwaiting,
  ConversationHistoryMessage,
} from "../api/conversation";
import {
  parseToolLinks,
  type ConversationContentPart,
  type JsonValue,
} from "./tool-steps";

export type ConversationConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface ConversationUserEntry {
  kind: "user";
  id: string;
  ts: number;
  text: string;
  /** True when the `/send` POST failed. The bubble shows a retry affordance;
   *  cleared on a successful resend. Failed bubbles are never in server
   *  history, so they're preserved across reconnect resync. */
  failed?: boolean;
  /** The message's client-generated identity (clientMsgId on POST /send).
   *  On an optimistic bubble it equals `id` (sendMessage mints one uuid for
   *  both); on a history / in-flight entry it's the echoed value. History
   *  rebuilds reconcile bubbles by this — same text ≠ same message. Absent
   *  on pre-clientMsgId rows, where reconciliation falls back to text. */
  clientId?: string;
  /** True while the message is waiting behind an already-running agent turn.
   *  This is client-local UI state; persisted history never carries it. */
  queued?: boolean;
}

export interface ConversationAssistantEntry {
  kind: "assistant";
  /** Stable React list key for the turn's whole lifetime. A live turn keeps
   *  its client-local "turn-N" id even after it persists — the real
   *  pai_chat_messages id lands in `serverId`, NOT here — so the list key
   *  never changes mid-turn (changing it would remount the entry = flicker). */
  id: string;
  ts: number;
  /** Ordered content parts (text / reasoning / tool-call), exactly the shape
   *  main chat's renderers consume. */
  parts: ConversationContentPart[];
  /** True while this turn is still streaming (before chat:done). Drives the
   *  shimmer / "Thinking…" affordance the same way main chat does. */
  running: boolean;
  /** Backend pai_chat_messages id, for feedback/thumbs joins. Present on
   *  history turns (equals `id`) and adopted by a live turn on chat:persisted;
   *  absent while a turn streams (thumbs stay disabled until it lands). */
  serverId?: string;
}

export type ConversationEntry =
  | ConversationUserEntry
  | ConversationAssistantEntry;

/** SSE envelope shape（与后端 shared/sse_envelope.py 对应）。 */
export interface ConversationSseEnvelope {
  type: string;
  ts?: number;
  traceId?: string;
  data?: Record<string, unknown>;
}

/** HITL: the turn paused on a side-effect tool awaiting approval
 *  (chat:requires_action frame / history page's `awaiting`). */
export interface HitlRequiresAction {
  /** = the frame's `interruptId`; matched to the awaiting run's pending_action
   *  on the backend (worker `_find_decision_message`). */
  toolUseId: string;
  toolName: string;
  argsPreview?: string;
  /** Structured tool input (same dict the backend sends on the frame / stores
   *  on pending_action). The card humanizes known tools from these fields;
   *  `argsPreview` stays as the fallback for tools without a template. */
  args?: Record<string, unknown>;
  /** Backend-advertised allowed decisions; empty → default [approve, reject]. */
  allowedDecisions: string[];
}

let entrySeq = 0;
export function nextEntryId(prefix: string): string {
  entrySeq += 1;
  return `${prefix}-${Date.now()}-${entrySeq}`;
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
    if (p.parentTaskId) {
      part.parentTaskId = p.parentTaskId;
      if (p.agentName) part.agentName = p.agentName;
    }
    if (p.groupTitle) part.groupTitle = p.groupTitle;
    const links = parseToolLinks(p.links);
    if (links) part.links = links;
    return part;
  });
}

/** Convert persisted history into transcript entries. */
export function historyToEntries(
  messages: ConversationHistoryMessage[],
): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const m of messages) {
    const ts = typeof m.createdAt === "number" ? m.createdAt : Date.now();
    if (m.role === "user") {
      out.push({
        kind: "user",
        id: m.id,
        ts,
        text: historyText(m),
        ...(m.clientMsgId ? { clientId: m.clientMsgId } : {}),
      });
      continue;
    }
    out.push({
      kind: "assistant",
      id: m.id,
      ts,
      parts: historyAssistantParts(m),
      running: false,
      serverId: m.id,
    });
  }
  return out;
}

/** Rebuild the paused (HITL) turn's partial entry from the history page's
 *  `awaiting.partialParts` so a refresh doesn't look like it wiped the
 *  thinking / tool calls streamed before the interrupt. Returns null when
 *  there's nothing to redraw. */
export function awaitingPartialEntry(
  awaiting: ConversationAwaiting | null,
): ConversationAssistantEntry | null {
  if (!awaiting?.partialParts?.length) return null;
  const [partial] = historyToEntries([
    {
      id: `partial-${awaiting.toolUseId}`,
      role: "assistant" as const,
      parts: awaiting.partialParts,
    },
  ]);
  if (partial?.kind !== "assistant") return null;
  return { ...partial, running: true };
}

/**
 * Resync 合并算法：把「服务端 history + 在途输入（unconsumed mailbox）」与
 * 本地乐观气泡合并成一份 transcript，不丢不重。
 *
 * - carry：history 没覆盖的本地 user 气泡保留（有 clientId 按身份判覆盖；
 *   无 id 的按文本判，failed 气泡永远保留——它们不可能在 history 里）。
 * - identity pass：在途输入的 clientId 命中本地气泡 → 已渲染，跳过；同时
 *   证明一个 "failed" 气泡的 POST 实际落地了 → 清 failed 标记。
 * - text-claim pass：无 id 的在途输入按文本逐个认领本地非 failed 气泡
 *   （计数认领而非 Set 去重，重复同文本的发送保持各自独立）。
 * - 没认领到的在途输入（如发送先于本次 reload）恢复成新气泡，保留身份。
 */
export function mergeTranscriptOnResync(
  prev: ConversationEntry[],
  history: ConversationEntry[],
  serverEntries: ConversationActiveEntry[],
): ConversationEntry[] {
  const historyClientIds = new Set(
    history.flatMap((e) =>
      e.kind === "user" && e.clientId ? [e.clientId] : [],
    ),
  );
  const historyUserText = new Set(
    history.flatMap((e) => (e.kind === "user" ? [e.text.trim()] : [])),
  );
  // A bubble with an id is covered iff history echoes that id — including a
  // "failed" bubble whose POST actually landed (the turn finished; keeping
  // it would render a stale duplicate).
  const carry = prev.filter(
    (e): e is ConversationUserEntry =>
      e.kind === "user" &&
      (e.clientId
        ? !historyClientIds.has(e.clientId)
        : e.failed === true || !historyUserText.has(e.text.trim())),
  );
  const carriedIds = new Set(
    carry.flatMap((e) => (e.clientId ? [e.clientId] : [])),
  );
  // Identity pass: pending inputs whose clientId matches a local bubble.
  // (Also proof a "failed" bubble's POST actually landed — flag cleared below.)
  const confirmedById = new Map<string, ConversationActiveEntry>();
  for (const s of serverEntries) {
    if (s.clientId && carriedIds.has(s.clientId)) {
      confirmedById.set(s.clientId, s);
    }
  }
  // Text-claim pool for the rest: non-failed bubbles not already claimed by
  // identity. Id-carrying bubbles are claimable too — an id-less server entry
  // (older backend) must still match the bubble of a send that DID carry one.
  const claimableTexts = new Map<string, number>();
  for (const e of carry) {
    if (e.failed || (e.clientId && confirmedById.has(e.clientId))) {
      continue;
    }
    const key = e.text.trim();
    claimableTexts.set(key, (claimableTexts.get(key) ?? 0) + 1);
  }
  const inflight: ConversationUserEntry[] = [];
  for (const s of serverEntries) {
    if (s.clientId) {
      // An id-bearing entry reconciles by identity ONLY: matched → already
      // rendered; unmatched → a send this client has no bubble for (another
      // tab/device, or pre-reload). Claiming by text here would swallow a
      // DIFFERENT same-text message — e.g. two tabs both sending "hello".
      if (confirmedById.has(s.clientId)) continue;
    } else {
      const key = s.text.trim();
      const claims = claimableTexts.get(key) ?? 0;
      if (claims > 0) {
        claimableTexts.set(key, claims - 1);
        continue;
      }
    }
    // No local bubble for this pending input (e.g. the send predates a
    // reload) — restore it, keeping its identity.
    inflight.push({
      kind: "user",
      id: s.clientId ?? nextEntryId("user"),
      ts: Date.now(),
      text: s.text,
      ...(s.clientId ? { clientId: s.clientId } : {}),
      ...(s.queued ? { queued: true } : {}),
    });
  }
  const carried = carry.map((e) => {
    if (!e.clientId) return e;
    const confirmed = confirmedById.get(e.clientId);
    if (!confirmed) return e;
    const next = e.failed ? { ...e, failed: false } : { ...e };
    if (confirmed.queued) next.queued = true;
    else delete next.queued;
    return next;
  });
  return [...history, ...carried, ...inflight];
}

/** 分流 transcript：queued user 气泡（等在 in-flight turn 后面、渲染在 composer
 *  上方的 QueuedMessagesPanel）与其余可见 transcript。 */
export function splitQueuedEntries(transcript: ConversationEntry[]): {
  visible: ConversationEntry[];
  queued: ConversationUserEntry[];
} {
  const visible: ConversationEntry[] = [];
  const queued: ConversationUserEntry[] = [];
  for (const entry of transcript) {
    if (entry.kind === "user" && entry.queued) queued.push(entry);
    else visible.push(entry);
  }
  return { visible, queued };
}

/** 暂停的 HITL turn 把审批卡 host 在它的 entry 上（流式停的地方）= 最后一个仍
 *  running 的 assistant entry。无 awaiting、或末尾 assistant 已结束 → null（审批
 *  卡走 Footer fallback 渲染）。 */
export function findHitlHostId(
  transcript: ConversationEntry[],
  hasAwaiting: boolean,
): string | null {
  if (!hasAwaiting) return null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.kind === "assistant") return e.running ? e.id : null;
  }
  return null;
}

/** Card result bar 的目标 message（纯 transcript 规则，UI 再叠加
 *  cardFeedback/busy/awaiting 的 gating）：末尾 entry 是已结束、有可见文本、无
 *  propose_action 的 assistant turn 时返回其 serverId（未落库为 null，thumbs 禁用
 *  到 chat:persisted 落 id）；否则 undefined（不显示 bar）。propose_action = 「需
 *  你决定」而非「结果」，故排除。 */
export function deriveCardResultMessageId(
  visibleTranscript: ConversationEntry[],
): string | null | undefined {
  const last = visibleTranscript[visibleTranscript.length - 1];
  if (!last || last.kind !== "assistant" || last.running) return undefined;
  const hasText = last.parts.some((p) => p.type === "text" && p.text.trim().length > 0);
  const hasProposal = last.parts.some(
    (p) => p.type === "tool-call" && p.toolName === "propose_action",
  );
  if (!hasText || hasProposal) return undefined;
  return last.serverId ?? null;
}

// ── Conversation runtime reducer（流式状态机）─────────────────────────────
// 把 useConversationRuntime 散在各处的 setState 状态转换提纯成纯
// (state, action) → state：① 消除 busy/awaitingDecision/threadId 的镜像 ref
// （reducer dispatch 天然拿最新 state，乐观 send 的 queued 判断也在 reducer
// 内做）；② envelope→state 转换可回放单测。LiveContentBuilder（mutable 增量
// 组装）仍留在 hook 的 ref，flush 时把 builder.snapshot() 经 `turn_flush` 写进
// 这里的 transcript（builder 不进纯 reducer）。switch body 自身不调 Date.now()
// ——流式 turn 的 ts 由 dispatch 方在 action 里 stamp；唯一例外是 `resync` 委派的
// mergeTranscriptOnResync，它为「reload 时恢复一个本地无对应气泡的在途输入」这一
// 罕见 fallback 仍 mint id + Date.now()（pre-existing，运行时无害，回放非确定）。

export interface ConversationState {
  transcript: ConversationEntry[];
  connection: ConversationConnectionState;
  ready: boolean;
  busy: boolean;
  awaitingDecision: HitlRequiresAction | null;
  threadId: string | null;
  hasMoreHistory: boolean;
  /** 流式 turn 在 transcript 的缓存 index（O(1) per-delta flush；-1 = 无）。 */
  turnPos: number;
}

export function initConversationState(session: string): ConversationState {
  return {
    transcript: [],
    connection: "connecting",
    ready: false,
    busy: false,
    awaitingDecision: null,
    threadId: session || null,
    hasMoreHistory: false,
    turnPos: -1,
  };
}

export type ConversationAction =
  // 标量
  | { type: "set_connection"; connection: ConversationConnectionState }
  | { type: "set_ready"; ready: boolean }
  | { type: "set_busy"; busy: boolean }
  | { type: "set_awaiting"; awaiting: HitlRequiresAction | null }
  | { type: "set_thread"; threadId: string }
  | { type: "set_has_more"; hasMoreHistory: boolean }
  // 流式 turn（builder.snapshot() 经此写 transcript；ts 由 dispatch 方 stamp）
  | { type: "turn_flush"; turnId: string; parts: ConversationContentPart[]; running: boolean; ts: number }
  | { type: "turn_drop"; turnId: string }
  // history / resync
  | { type: "resync"; history: ConversationEntry[]; serverEntries: ConversationActiveEntry[] }
  | { type: "prepend_history"; entries: ConversationEntry[] }
  // 乐观 user 气泡（queued 由 reducer 据 busy/awaiting 判定 → 消除镜像 ref）
  | { type: "optimistic_user"; id: string; text: string; ts: number }
  | { type: "mark_failed"; id: string; failed: boolean }
  | { type: "set_user_text"; id: string; text: string }
  | { type: "set_user_queued"; id: string; queued: boolean }
  | { type: "remove_user"; id: string }
  | { type: "insert_user_at"; index: number; entry: ConversationUserEntry }
  // turn 维护
  | { type: "persisted"; messageId: string }
  | { type: "clear_queued_flags" }
  | { type: "drop_trailing_assistant" };

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "set_connection":
      return { ...state, connection: action.connection };
    case "set_ready":
      return { ...state, ready: action.ready };
    case "set_busy":
      return { ...state, busy: action.busy };
    case "set_awaiting":
      return { ...state, awaitingDecision: action.awaiting };
    case "set_thread":
      return { ...state, threadId: action.threadId };
    case "set_has_more":
      return { ...state, hasMoreHistory: action.hasMoreHistory };
    case "turn_flush": {
      // 搬 turn-assembly flushTurn：turnPos 缓存命中则原地更新，否则 findIndex；
      // 缺失则 append（新 turn entry）。ts 仅 append 时用（更新保留 existing.ts）。
      const { turnId, parts, running, ts } = action;
      let idx = state.turnPos;
      const cached =
        idx >= 0 && idx < state.transcript.length ? state.transcript[idx] : undefined;
      if (!cached || cached.kind !== "assistant" || cached.id !== turnId) {
        idx = state.transcript.findIndex((e) => e.kind === "assistant" && e.id === turnId);
      }
      if (idx === -1) {
        return {
          ...state,
          transcript: [
            ...state.transcript,
            { kind: "assistant", id: turnId, ts, parts, running },
          ],
          turnPos: state.transcript.length,
        };
      }
      const next = state.transcript.slice();
      const existing = next[idx] as ConversationAssistantEntry;
      next[idx] = { ...existing, parts, running };
      return { ...state, transcript: next, turnPos: idx };
    }
    case "turn_drop":
      // finalizeTurn：builder 无可见 parts 时删掉空 turn entry。
      return {
        ...state,
        transcript: state.transcript.filter(
          (e) => !(e.kind === "assistant" && e.id === action.turnId),
        ),
        turnPos: -1,
      };
    case "resync":
      return {
        ...state,
        transcript: mergeTranscriptOnResync(state.transcript, action.history, action.serverEntries),
        turnPos: -1,
      };
    case "prepend_history":
      return {
        ...state,
        transcript: [...action.entries, ...state.transcript],
        // prepend 把现有 entry 右移；保持 turnPos 指向同一 turn。
        turnPos: state.turnPos >= 0 ? state.turnPos + action.entries.length : -1,
      };
    case "optimistic_user": {
      // queued = 已有 in-flight turn / 待审批（取代旧 busyRef||awaitingRef 镜像）。
      const queued = state.busy || state.awaitingDecision !== null;
      const entry: ConversationUserEntry = {
        kind: "user",
        id: action.id,
        ts: action.ts,
        text: action.text,
        clientId: action.id,
        ...(queued ? { queued: true } : {}),
      };
      return { ...state, transcript: [...state.transcript, entry] };
    }
    case "mark_failed":
      return {
        ...state,
        transcript: state.transcript.map((e) =>
          e.kind === "user" && e.id === action.id ? { ...e, failed: action.failed } : e,
        ),
      };
    case "set_user_text":
      return {
        ...state,
        transcript: state.transcript.map((e) =>
          e.kind === "user" && e.id === action.id ? { ...e, text: action.text } : e,
        ),
      };
    case "set_user_queued":
      return {
        ...state,
        transcript: state.transcript.map((e) =>
          e.kind === "user" && e.id === action.id ? { ...e, queued: action.queued } : e,
        ),
      };
    case "remove_user":
      return {
        ...state,
        transcript: state.transcript.filter((e) => !(e.kind === "user" && e.id === action.id)),
      };
    case "insert_user_at": {
      // 删除回滚：原位插回（已存在则 no-op，幂等）。
      if (state.transcript.some((e) => e.kind === "user" && e.id === action.entry.id)) return state;
      const insertAt =
        action.index >= 0 ? Math.min(action.index, state.transcript.length) : state.transcript.length;
      return {
        ...state,
        transcript: [
          ...state.transcript.slice(0, insertAt),
          action.entry,
          ...state.transcript.slice(insertAt),
        ],
      };
    }
    case "persisted": {
      // chat:persisted：真实 pai_chat_messages id 落到最后一个 assistant 的
      // serverId（NOT id——改 id 会让 Virtuoso key 变致 remount flicker）。
      const mid = action.messageId;
      const t = state.transcript;
      for (let i = t.length - 1; i >= 0; i--) {
        if (t[i].kind === "assistant") {
          const a = t[i] as ConversationAssistantEntry;
          if (a.serverId === mid) return state;
          const next = t.slice();
          next[i] = { ...a, serverId: mid };
          return { ...state, transcript: next };
        }
      }
      return state;
    }
    case "clear_queued_flags":
      // chat:done：把排队 user 气泡的 queued 标记清掉。
      return {
        ...state,
        transcript: state.transcript.map((e) =>
          e.kind === "user" && e.queued ? { ...e, queued: false } : e,
        ),
      };
    case "drop_trailing_assistant": {
      // regenerate：丢弃末尾 assistant turn（含其后所有，沿用 slice 到该 idx）。
      let lastAssistantIdx = -1;
      for (let i = state.transcript.length - 1; i >= 0; i--) {
        if (state.transcript[i].kind === "assistant") {
          lastAssistantIdx = i;
          break;
        }
      }
      return lastAssistantIdx >= 0
        ? { ...state, transcript: state.transcript.slice(0, lastAssistantIdx), turnPos: -1 }
        : state;
    }
  }
}
