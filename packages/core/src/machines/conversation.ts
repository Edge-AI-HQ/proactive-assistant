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
  /** The message's client-generated identity (clientMsgId on POST /send).
   *  On an optimistic bubble it equals `id` (sendMessage mints one uuid for
   *  both); on a history / in-flight entry it's the echoed value. History
   *  rebuilds reconcile bubbles by this — same text ≠ same message. Absent
   *  on pre-clientMsgId rows, where reconciliation falls back to text. */
  clientId?: string;
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
      debug: m.trigger === "tick" || lastInputWasTick,
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
  const confirmedIds = new Set<string>();
  for (const s of serverEntries) {
    if (s.clientId && carriedIds.has(s.clientId)) {
      confirmedIds.add(s.clientId);
    }
  }
  // Text-claim pool for the rest: non-failed bubbles not already claimed by
  // identity. Id-carrying bubbles are claimable too — an id-less server entry
  // (older backend) must still match the bubble of a send that DID carry one.
  const claimableTexts = new Map<string, number>();
  for (const e of carry) {
    if (e.failed || (e.clientId && confirmedIds.has(e.clientId))) {
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
      if (confirmedIds.has(s.clientId)) continue;
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
    });
  }
  const carried = carry.map((e) =>
    e.failed && e.clientId && confirmedIds.has(e.clientId)
      ? { ...e, failed: false }
      : e,
  );
  return [...history, ...carried, ...inflight];
}
