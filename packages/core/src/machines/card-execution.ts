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
 * 本文件是 transcript（ConversationEntry[]）→ RunSnapshot 的全部转换与状态
 * 合成逻辑：纯函数、可回放测试（见 card-execution.test.ts）。card detail 与
 * main chat 现共用同一 SSE conversation runtime，snapshot 是其 transcript 上的
 * 纯派生（deriveRunSnapshot）。SSE 生命周期编排在 @pin-ai/state 的
 * queries/card-execution.ts。
 */
import { stripRequestOnlyCardContext } from "../domain/card-chat-session";
import type { ConversationEntry, HitlRequiresAction } from "./conversation";
import type { ConversationContentPart } from "./tool-steps";

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

export const CARD_THREAD_PREFIX = "card-thread-";

export function cardSessionKeyFor(runId: string): string {
  if (runId.startsWith(CARD_THREAD_PREFIX)) return runId;
  return `${CARD_THREAD_PREFIX}${runId}`;
}

// ── transcript → RunSnapshot adapter ─────────────────────────────────────

type ToolCallPart = Extract<ConversationContentPart, { type: "tool-call" }>;

/** Tool-call status from a transcript content part. historyAssistantParts /
 *  LiveContentBuilder both stash it under `args.status` ("running"|"ok"|
 *  "error"); a settled call also carries `result`/`isError`, but `args.status`
 *  is the single source both paths agree on. */
function toolStatus(part: ToolCallPart): "running" | "ok" | "error" {
  const s = part.args.status;
  return s === "ok" || s === "error" ? s : "running";
}

/** Pull the propose_action structured args from a transcript tool-call part.
 *  The structured payload lives in `part.args.input` (historyAssistantParts /
 *  LiveContentBuilder wrap the raw tool args under `input`). Tolerant: when
 *  `input` is missing (e.g. the call exceeded the 8 KB cap), propose_action's
 *  payload is unavailable and the FE falls back to argsPreview-only rendering. */
function parseProposeAction(part: ToolCallPart): PendingInput | null {
  if (part.toolName !== "propose_action") return null;
  const raw = part.args.input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
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

/** Walk the unified transcript (ConversationEntry[]) and synthesize the
 *  RunSnapshot the card drawer expects — the same projection
 *  chatHistoryToSnapshot did from a history page, but now sourced from the
 *  single conversation runtime (SSE) so card detail and main chat share ONE
 *  data path. Each tool-call → (chat:tool:start, chat:tool:result?) events;
 *  each propose_action → an input_required event (StaticPauseCard reads
 *  metadata.plan_revisions / events). Status is synthesized from the transcript
 *  tail + the runtime's busy / awaiting state: an in-flight turn shows as a
 *  `running` trailing assistant entry once frames stream, and `ctx.busy`
 *  (= the old history page's `active != null`) covers the gap before the first
 *  frame — together replacing the old page.active/awaiting override. */
export function deriveRunSnapshot(
  sessionKey: string,
  transcript: ConversationEntry[],
  ctx: { awaitingDecision: HitlRequiresAction | null; busy: boolean },
): RunSnapshot {
  const events: SSEEvent[] = [];
  let latestProposeAction: PendingInput | null = null;
  let finalText = "";
  let saw_error_part = false;
  // Each propose_action opens a "pause slot" the NEXT user turn fills —
  // StaticPauseCard reads these via snapshot.metadata.plan_revisions[i].reply
  // (durable past user replies, survives refresh / reconnect).
  const planRevisions: Array<{ reply: string }> = [];
  let awaitingUserReplyForPause = false;

  for (const entry of transcript) {
    if (entry.kind === "user") {
      if (awaitingUserReplyForPause) {
        const replyText = entry.text.trim();
        if (replyText) {
          planRevisions.push({ reply: stripRequestOnlyCardContext(replyText) });
          awaitingUserReplyForPause = false;
        }
      }
      continue;
    }
    for (const part of entry.parts) {
      if (part.type === "tool-call") {
        const status = toolStatus(part);
        events.push({
          type: "chat:tool:start",
          ts: entry.ts,
          data: {
            toolCallId: part.toolCallId,
            name: part.toolName,
            argsPreview:
              typeof part.args.argsPreview === "string" ? part.args.argsPreview : "",
            args: part.args.input,
          },
        });
        if (status === "ok" || status === "error") {
          if (status === "error") saw_error_part = true;
          events.push({
            type: "chat:tool:result",
            ts: entry.ts,
            data: {
              toolCallId: part.toolCallId,
              isError: status === "error",
              meta: typeof part.args.meta === "string" ? part.args.meta : "",
            },
          });
        }
        const proposed = parseProposeAction(part);
        if (proposed) {
          latestProposeAction = proposed;
          events.push({
            type: "input_required",
            ts: entry.ts,
            data: proposed as unknown as Record<string, unknown>,
          });
          awaitingUserReplyForPause = true;
        }
      } else if (part.type === "text") {
        // The agent's prose; the trailing run becomes the `result` summary.
        finalText += part.text;
      }
    }
  }

  // Status synthesis. In-flight shows as a `running` trailing assistant entry
  // once frames stream; ctx.busy (= old history page's `active != null`) covers
  // the pre-first-frame gap (regenerate / resync); HITL pause is the runtime's
  // awaitingDecision — together they replace the old page.active / page.awaiting
  // override. Otherwise inspect the last assistant turn (running tool → running
  // / propose_action → needs_input / final text → pending_done / tool error →
  // error).
  let status: RunStatus = "running";
  let result: RunResult | null = null;
  let errorMessage: string | null = null;
  const lastEntry = transcript.length > 0 ? transcript[transcript.length - 1] : null;
  const lastRunning = lastEntry?.kind === "assistant" && lastEntry.running;
  const inFlight = Boolean(lastRunning || ctx.awaitingDecision || ctx.busy);

  if (ctx.awaitingDecision) {
    // HITL pause: drawer can't render the approval gate (CardChat's
    // ConversationView does) — surface needs_input so the user opens the chat.
    status = "needs_input";
  } else if (lastRunning || ctx.busy) {
    // In-flight: a `running` trailing entry once frames stream, OR ctx.busy
    // (= the old history page's `active != null`) before the first frame —
    // covers regenerate-in-flight / resync-to-active so the drawer doesn't
    // flash the previous turn's pending_done/needs_input until a frame lands.
    status = "running";
  } else if (!lastEntry) {
    // Fresh thread (fanout hasn't fired / not reached the worker).
    status = "running";
  } else if (lastEntry.kind === "user") {
    status = "running";
  } else {
    const parts = lastEntry.parts;
    const hasProposeAction = parts.some(
      (p) => p.type === "tool-call" && p.toolName === "propose_action",
    );
    const hasRunningTool = parts.some(
      (p) => p.type === "tool-call" && toolStatus(p) === "running",
    );
    const hasFinalText = parts.some((p) => p.type === "text" && Boolean(p.text));
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
