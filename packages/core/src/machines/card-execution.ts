/**
 * Card-execution 状态机（纯 TS）—— 分层 Phase 3 从
 * proactive-ai-frontend hooks/useCardExecutionRun.ts 提纯。
 *
 * Cards run on the unified `/api/conversation/*` pipeline scoped by
 * session_key `card-thread-<card_id>`. The agent (`card_execution.py`)
 * calls the `propose_action` tool to surface chips / drafts / plan to
 * the user, and the user's reply is just a normal user turn on the
 * same thread.
 *
 * 本文件是 history page → RunSnapshot 的全部转换与状态合成逻辑：
 * 纯函数、可回放测试（见 card-execution.test.ts）。轮询/bootstrap 的
 * React 生命周期编排在 @pin-ai/state 的 queries/card-execution.ts。
 */
import {
  type ConversationHistoryMessage,
  type ConversationHistoryPage,
  type ConversationHistoryToolCallPart,
} from "../api/conversation";
import { stripRequestOnlyCardContext } from "../domain/card-chat-session";

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

export function messagePayloadEqual(
  a: LastMessagePayload | null,
  b: LastMessagePayload | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function toMessagePayload(p: PendingInput): LastMessagePayload {
  return {
    message: p.message,
    drafts: p.drafts ?? [],
    options: p.options ?? null,
    plan: p.plan ?? [],
    dangerous_actions: p.dangerous_actions ?? [],
    risks: p.risks ?? [],
  };
}

export function mergeAuditFields(
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

export const CARD_EXECUTION_TERMINAL: ReadonlySet<RunStatus> = new Set([
  "done",
  "error",
  "cancelled",
]);

export const CARD_THREAD_PREFIX = "card-thread-";

export function cardSessionKeyFor(runId: string): string {
  if (runId.startsWith(CARD_THREAD_PREFIX)) return runId;
  return `${CARD_THREAD_PREFIX}${runId}`;
}

// ── conversation history → RunSnapshot adapter ───────────────────────────

/** Narrowed text part of a history message (api ConversationHistoryPart). */
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
export function chatHistoryToSnapshot(
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

// ── Derived projections（迁移前散在 hook 的 useEffect/useMemo 里）──────────

/** Hydration 路径：walk events newest→oldest looking for the most recent
 *  propose_action that DID carry audit fields, so the Drawer's pre-review
 *  keeps showing plan / dangerous_actions / risks across re-drafts that
 *  omitted them. Returns null when the log has no propose_action yet. */
export function deriveLastMessagePayload(events: SSEEvent[]): LastMessagePayload | null {
  let latest: LastMessagePayload | null = null;
  let audit: Pick<
    LastMessagePayload, "plan" | "dangerous_actions" | "risks"
  > | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
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
  if (latest === null) return null;
  return audit ? { ...latest, ...audit } : latest;
}

/** How many distinct propose_action tool calls the agent has emitted on
 *  this card-thread so far. Flips "Generated draft" → "Updated draft v2"
 *  and re-expands the draft card on each new version. */
export function countProposeActions(events: SSEEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.type !== "input_required") continue;
    const data = ev.data as { kind?: string } | undefined;
    if (data?.kind === "message") n++;
  }
  return n;
}
