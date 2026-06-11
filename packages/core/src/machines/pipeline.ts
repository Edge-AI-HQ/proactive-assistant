/**
 * Generator pipeline 状态机（纯 TS）—— 分层 Phase 3 从
 * proactive-ai-frontend hooks/usePipeline.ts 提纯。
 *
 * RunState 的全部状态转移（F5 安全网 settle、/status 恢复、dispatch、
 * agent-runs 反应、grace settle、孤儿采纳）都是 (prev, input) → next 的
 * 纯函数，可回放测试（pipeline.test.ts）。React 编排（effects 时序、
 * sessionStorage 注入、AbortController）在 @pin-ai/state 的
 * queries/pipeline.ts。
 */
import { hasInflightAgentRuns, type ActiveAgentRun } from "../api/agent-runs";
import { normalizeIntentCards, type IntentCard } from "../domain/intent-card";
import type { EvaluationScore } from "../domain/intent-card";

export interface LogEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
  timestamp: string;
}

export type PipelinePhase = "planning" | "generating" | "evaluating" | "complete";
export type PipelineRunStatus = "idle" | "connecting" | "running" | "complete" | "error";

export interface RunState {
  runId: string | null;
  status: PipelineRunStatus;
  activePhase: PipelinePhase | null;
  startedAt: string | null;
  completedAt: string | null;
  finalCards: IntentCard[];
  scoreMap: Record<string, EvaluationScore>;
  logEntries: LogEntry[];
  error: string | null;
  /**
   * Agent's batch-level commentary, populated by /runs/:id. Most useful when
   * `status='complete' && finalCards.length===0` so the UI can explain why
   * the agent declined to generate. null when the agent didn't emit one or
   * the run hasn't completed.
   */
  batchFeedback: string | null;
}

export function makeLogEntry(
  kind: string,
  title: string,
  detail: string,
  extra?: Partial<LogEntry>,
): LogEntry {
  return {
    id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind, title, detail,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

const LOG_CAP = 80;

export function prependLog(prev: RunState, entry: LogEntry): RunState {
  return { ...prev, logEntries: [entry, ...prev.logEntries].slice(0, LOG_CAP) };
}

export function createInitialRunState(): RunState {
  return {
    runId: null,
    status: "idle", activePhase: null,
    startedAt: null, completedAt: null, finalCards: [],
    scoreMap: {}, logEntries: [], error: null,
    batchFeedback: null,
  };
}

export function isRunState(value: unknown): value is RunState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.status === "string" &&
    Array.isArray(v.finalCards) &&
    typeof v.scoreMap === "object" &&
    Array.isArray(v.logEntries)
  );
}

/** 解析持久化的 RunState 串（sessionStorage 等）：校验形状、normalize
 *  cards、补默认字段。坏数据返回 null（调用方负责清掉存储）。 */
export function parseStoredRunState(raw: string | null): RunState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRunState(parsed)) return null;
    return {
      ...parsed,
      finalCards: normalizeIntentCards(parsed.finalCards),
      // Older stored entries may not have batchFeedback; default to null
      // instead of leaving it undefined.
      batchFeedback: typeof parsed.batchFeedback === "string" ? parsed.batchFeedback : null,
    };
  } catch {
    return null;
  }
}

export function isActiveRunStatus(status: PipelineRunStatus): boolean {
  return status === "running" || status === "connecting";
}

// ── 状态转移（原 hook 各 setRun 回调的纯化）──────────────────────────────

/** Page-reload safety net：恢复出 active 状态但没有连接接管 → settle 回
 *  complete（有卡保留）或 idle。无需 settle 时原样返回 prev（引用相等）。 */
export function settleStaleRun(prev: RunState): RunState {
  if (!isActiveRunStatus(prev.status)) return prev;

  if (prev.finalCards.length > 0) {
    return prependLog(
      {
        ...prev,
        status: "complete",
        activePhase: "complete",
        completedAt: prev.completedAt ?? new Date().toISOString(),
        error: null,
      },
      makeLogEntry("system", "Run settled", "Backend is no longer running; keeping recovered cards"),
    );
  }

  return prependLog(
    {
      ...prev,
      status: "idle",
      activePhase: null,
      error: null,
      completedAt: prev.completedAt ?? new Date().toISOString(),
    },
    makeLogEntry("system", "Run settled", "Backend is no longer running"),
  );
}

/** `/api/status` 响应的宽松形状（旧后端字段可缺）。 */
export interface PipelineStatusPayload {
  pipelineRunning?: boolean;
  phase?: PipelinePhase;
  latestRun?: {
    id?: unknown;
    status?: string;
    error?: unknown;
    completedAt?: unknown;
  } | null;
  lastResult?: {
    id?: string;
    finalCards?: unknown;
    batchFeedback?: unknown;
    completedAt?: string;
  } | null;
}

/** `/api/status` 的恢复决策（mount 时跑一次）。返回 null = 无需变更。 */
export function applyStatusCheck(
  prev: RunState,
  data: PipelineStatusPayload,
): RunState | null {
  if (data.pipelineRunning && prev.status !== "running") {
    return prependLog(
      {
        ...prev,
        status: "running",
        activePhase: (data.phase as PipelinePhase | undefined) ?? prev.activePhase,
      },
      makeLogEntry("system", "Reconnected", "Pipeline is still running on the backend"),
    );
  }
  if (!data.pipelineRunning && data.latestRun?.status === "failed" && prev.status !== "error") {
    const errMsg = typeof data.latestRun.error === "string" ? data.latestRun.error : "Pipeline failed";
    return prependLog(
      {
        ...prev,
        runId: typeof data.latestRun.id === "string" ? data.latestRun.id : prev.runId,
        status: "error",
        activePhase: null,
        finalCards: [],
        error: errMsg,
        completedAt:
          typeof data.latestRun.completedAt === "string"
            ? data.latestRun.completedAt
            : new Date().toISOString(),
      },
      makeLogEntry("error", "Pipeline failed", typeof data.latestRun.error === "string" ? data.latestRun.error : "Backend returned failed"),
    );
  }
  if (
    !data.pipelineRunning &&
    data.lastResult &&
    (!data.latestRun || data.latestRun.status === "completed") &&
    prev.status !== "complete" &&
    prev.finalCards.length === 0
  ) {
    const recoveredCards = normalizeIntentCards(data.lastResult.finalCards);
    const recoveredFeedback =
      typeof data.lastResult.batchFeedback === "string"
        ? data.lastResult.batchFeedback
        : null;
    return prependLog(
      {
        ...prev,
        runId: data.lastResult.id ?? prev.runId,
        status: "complete",
        activePhase: "complete",
        finalCards: recoveredCards,
        batchFeedback: recoveredFeedback,
        completedAt: data.lastResult.completedAt ?? new Date().toISOString(),
      },
      makeLogEntry("system", "Recovered results", `${recoveredCards.length} cards from previous run`),
    );
  }
  return null;
}

/** 起跑状态（generate 点击即时反馈）。 */
export function dispatchingRunState(): RunState {
  return prependLog(
    {
      ...createInitialRunState(),
      status: "connecting",
      startedAt: new Date().toISOString(),
    },
    makeLogEntry("system", "Dispatching", "Requested card generation"),
  );
}

/** `/generate` 202 响应（taskId / deduped）。 */
export function applyDispatchAccepted(
  prev: RunState,
  payload: Record<string, unknown>,
): RunState {
  const taskId =
    typeof payload.taskId === "string"
      ? payload.taskId
      : typeof payload.runId === "string"
        ? payload.runId
        : null;
  const deduped = payload.deduped === true;
  return prependLog(
    {
      ...prev,
      runId: taskId ?? prev.runId,
      status: "running",
      activePhase: "generating",
    },
    makeLogEntry(
      "system",
      deduped ? "Already running" : "Run queued",
      deduped
        ? "An existing generator run is in flight; following it"
        : `taskId=${taskId ?? "?"}`,
    ),
  );
}

export function applyDispatchError(prev: RunState, errMsg: string): RunState {
  return prependLog(
    {
      ...prev,
      status: "error",
      error: errMsg,
      completedAt: new Date().toISOString(),
    },
    makeLogEntry("error", "Dispatch failed", errMsg),
  );
}

/** 已结算 run 的 `/runs/:id` 结果落地。 */
export function applyRunResult(
  prev: RunState,
  finalCards: IntentCard[],
  batchFeedback: string | null,
): RunState {
  return prependLog(
    {
      ...prev,
      status: "complete",
      activePhase: "complete",
      completedAt: new Date().toISOString(),
      finalCards,
      batchFeedback,
    },
    makeLogEntry(
      "complete",
      finalCards.length > 0 ? "Pipeline complete" : "No new cards",
      finalCards.length > 0
        ? `${finalCards.length} card(s) ready`
        : (batchFeedback ?? "Agent declined to generate this run"),
    ),
  );
}

export function applyRunFailure(prev: RunState, errMsg: string): RunState {
  return prependLog(
    {
      ...prev,
      status: "error",
      error: errMsg,
      completedAt: new Date().toISOString(),
    },
    makeLogEntry("error", "Pipeline failed", errMsg),
  );
}

/** F5 grace settle：server feed 里没有本地 runId（5s 宽限后）。 */
export function settleVanishedRun(prev: RunState): RunState {
  return prev.finalCards.length > 0
    ? { ...prev, status: "complete", activePhase: "complete" }
    : { ...prev, status: "idle", activePhase: null, error: null };
}

/** 孤儿 generator run 采纳（本地 idle 但 server 已有在跑的）。 */
export function adoptOrphanRun(prev: RunState, orphan: ActiveAgentRun): RunState {
  return prependLog(
    {
      ...prev,
      runId: orphan.id,
      status: "running",
      activePhase: "generating",
      startedAt: orphan.startedAt ?? prev.startedAt ?? new Date().toISOString(),
    },
    makeLogEntry("system", "Resumed", `Following existing generator run ${orphan.id}`),
  );
}

export function findOrphanGeneratorRun(runs: ActiveAgentRun[]): ActiveAgentRun | undefined {
  return runs.find(
    (r) =>
      r.kind === "generator.manual" &&
      (r.status === "queued" || r.status === "running"),
  );
}

export function hasServerActiveGenerator(runs: ActiveAgentRun[]): boolean {
  return findOrphanGeneratorRun(runs) !== undefined;
}

// re-export 给 hook 做空闲判定（与 agent-runs 域共用）。
export { hasInflightAgentRuns };
