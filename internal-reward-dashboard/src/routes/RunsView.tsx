import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Database,
  Eye,
  GitBranch,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { listActiveAgentRuns, listRuns, percentLabel, scoreLabel, triggerGenerate } from "@/api/reward";
import type { AgentRunSummary, RunSummary } from "@/api/reward";
import { MetricStrip } from "@/components/MetricStrip";
import { StateBlock } from "@/components/StateBlock";
import { dashboardRouteDisabledReason, dashboardRoutes, firstDashboardRouteId, hasDashboardRouteId } from "@/lib/dashboardRoutes";
import { formatDateTimeOrDash } from "@/lib/dateFormat";
import { dateRangeOrderError, dayEndIso, dayStartIso } from "@/lib/dateRange";
import { runCardCount, runCasebookCount, runEvaluatorGap, runReviewedCount } from "@/lib/runSummary";
import { REWARD_TEXT_FILTER_MAX_LENGTH, textFilterLengthError } from "@/lib/textFilter";

interface RunsViewProps {
  onNavigate: (path: string) => void;
}

interface RunsQueryState {
  quality: "" | "aha" | "dead" | "reviewer_aha";
  reviewed: "" | "true" | "false";
  since: string;
  trigger: string;
  until: string;
}

export type FocusMode =
  | "all"
  | "in_progress"
  | "needs_review"
  | "empty_results"
  | "trace_missing"
  | "eval_gap"
  | "has_cases";

type HealthTone = "bad" | "good" | "neutral" | "warn";
type StatusPillTone =
  | "completed"
  | "empty"
  | "failed"
  | "missing"
  | "neutral"
  | "pending"
  | "queued"
  | "ready"
  | "running"
  | "succeeded";

export const MANUAL_GENERATOR_MAX_ATTEMPTS = 2;
const statusPillTones = new Set<string>([
  "completed",
  "failed",
  "pending",
  "queued",
  "ready",
  "running",
  "succeeded",
]);
const traceStatusLabels: Record<string, string> = {
  failed: "失败",
  missing: "缺失",
  pending: "生成中",
  ready: "已就绪",
};

function formatCompactDateTime(value: string | null | undefined): string {
  return formatDateTimeOrDash(value, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}

export function shortRunId(run: RunSummary): string {
  const id = firstDashboardRouteId(run.runId, run.id) || "未保存";
  return id.length > 16 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function runStableKey(run: RunSummary): string {
  const routeId = firstDashboardRouteId(run.id, run.runId);
  return routeId || `${run.status}:${run.startedAt ?? ""}:${run.completedAt ?? ""}`;
}

export function reviewPercent(run: RunSummary): number {
  const cardCount = runCardCount(run);
  if (cardCount <= 0) return 0;
  return Math.min(100, Math.round((runReviewedCount(run) / cardCount) * 100));
}

export function remainingReviews(run: RunSummary): number {
  return Math.max(0, runCardCount(run) - runReviewedCount(run));
}

function runTime(run: RunSummary): number {
  const value = run.completedAt ?? run.startedAt;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function latestVisibleRun(runs: RunSummary[]): RunSummary | null {
  return [...runs].sort((a, b) => runTime(b) - runTime(a))[0] ?? null;
}

function isInFlightRun(run: RunSummary): boolean {
  return run.status === "queued" || run.status === "running";
}

function isGenerationTaskRow(run: RunSummary): boolean {
  return isInFlightRun(run) || (
    runCardCount(run) === 0
    && (run.status === "succeeded" || run.status === "failed")
  );
}

function isActiveAgentPlaceholder(run: RunSummary): boolean {
  return run.attempts !== undefined || run.maxAttempts !== undefined || run.lastError !== undefined;
}

export function canOpenRunArtifacts(run: RunSummary): boolean {
  return !isInFlightRun(run)
    && !isActiveAgentPlaceholder(run)
    && hasDashboardRouteId(runDetailRouteId(run));
}

export function runDetailRouteId(run: RunSummary): string {
  return firstDashboardRouteId(run.id, run.runId);
}

export function runTraceRouteId(run: RunSummary): string {
  return firstDashboardRouteId(run.runId, run.id);
}

export function canOpenRunTrace(run: RunSummary): boolean {
  return canOpenRunArtifacts(run) && hasDashboardRouteId(runTraceRouteId(run));
}

function isEmptyCompletedRun(run: RunSummary): boolean {
  return run.status === "completed" && runCardCount(run) === 0;
}

function activeRunAttemptText(run: RunSummary): string | null {
  if (
    typeof run.attempts !== "number"
    || typeof run.maxAttempts !== "number"
    || !Number.isFinite(run.attempts)
    || !Number.isFinite(run.maxAttempts)
    || run.attempts < 0
    || run.maxAttempts <= 0
  ) return null;
  return `尝试 ${Math.floor(run.attempts)}/${Math.floor(run.maxAttempts)}`;
}

function activeRunErrorText(run: RunSummary): string | null {
  const error = run.lastError?.replace(/\s+/g, " ").trim();
  if (!error) return null;
  return error.length <= 140 ? error : `${error.slice(0, 139).trim()}...`;
}

export function evaluatorGap(run: RunSummary): number | null {
  return runEvaluatorGap(run);
}

export function evaluatorGapMagnitude(run: RunSummary): number {
  return Math.abs(evaluatorGap(run) ?? 0);
}

function evaluatorGapSignal(run: RunSummary): string | null {
  const gap = evaluatorGap(run);
  if (gap === null || Math.abs(gap) < 3) return null;
  return gap > 0
    ? `评估分比人工/用户高 ${gap.toFixed(1)}`
    : `评估分比人工/用户低 ${Math.abs(gap).toFixed(1)}`;
}

function finitePositiveRate(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : null;
}

export function signalText(run: RunSummary): string {
  if (isInFlightRun(run)) {
    const attempt = activeRunAttemptText(run);
    return attempt
      ? `生成进行中，${attempt}，完成后会自动显示卡片数量和详情`
      : "生成进行中，完成后会自动显示卡片数量和详情";
  }
  if (run.status === "succeeded" && runCardCount(run) === 0) return "生成刚完成，正在刷新卡片列表";
  if (run.status === "failed" && runCardCount(run) === 0) {
    const error = activeRunErrorText(run);
    return error ? `生成失败：${error}` : "生成失败：没有返回错误详情，请重新触发或刷新批次列表确认是否已落库";
  }
  if (isEmptyCompletedRun(run)) return "生成完成，但没有卡片通过评估或写入 final_cards";
  const signals: string[] = [];
  const gapSignal = evaluatorGapSignal(run);
  if (gapSignal) signals.push(gapSignal);
  const deadCardRate = finitePositiveRate(run.deadCardRate);
  const ahaRate = finitePositiveRate(run.ahaRate);
  if (deadCardRate !== null) signals.push(`${percentLabel(deadCardRate)} 废卡`);
  if (ahaRate !== null) signals.push(`${percentLabel(ahaRate)} AHA`);
  if (run.traceStatus !== "ready") signals.push(`链路${traceStatusLabel(run.traceStatus)}`);
  if (runCasebookCount(run) > 0) signals.push(`${runCasebookCount(run)} 个样本`);
  return signals.length ? signals.join(" / ") : "暂无突出信号";
}

export function queueTone(run: RunSummary): HealthTone {
  if (isInFlightRun(run) || evaluatorGapMagnitude(run) >= 3 || run.status === "failed") return "bad";
  if (run.traceStatus !== "ready" || remainingReviews(run) > 0 || isEmptyCompletedRun(run)) return "warn";
  if (runCasebookCount(run) > 0) return "good";
  return "neutral";
}

export function queueLabel(run: RunSummary): string {
  if (isInFlightRun(run)) return "生成中";
  if (run.status === "failed") return "生成失败";
  if (isEmptyCompletedRun(run)) return "空结果";
  if (evaluatorGapMagnitude(run) >= 3) return "分差优先";
  if (remainingReviews(run) > 0) return "待评审";
  if (run.traceStatus !== "ready") return "缺链路";
  if (runCasebookCount(run) > 0) return "已入样本";
  return "稳定";
}

export function queuePriority(run: RunSummary): number {
  if (isInFlightRun(run)) return 80;
  if (run.status === "failed") return 78;
  if (evaluatorGapMagnitude(run) >= 3) return 70;
  if (remainingReviews(run) > 0) return 60 + remainingReviews(run);
  if (run.traceStatus !== "ready" && runCardCount(run) > 0) return 50;
  if (isEmptyCompletedRun(run)) return 40;
  if (runCasebookCount(run) > 0) return 20;
  return 0;
}

export function queueReason(run: RunSummary): string {
  if (isInFlightRun(run)) {
    const attempt = activeRunAttemptText(run);
    return attempt ? `生成进行中，${attempt}，完成后进入逐卡评审` : "生成完成后进入逐卡评审";
  }
  if (run.status === "failed") {
    const error = activeRunErrorText(run);
    return error ? `任务错误：${error}` : "需要看任务错误和输入上下文";
  }
  if (isEmptyCompletedRun(run)) return "没有落地卡片，先确认 generator / evaluator 过滤原因";
  const gap = evaluatorGap(run);
  if (gap !== null && Math.abs(gap) >= 3) return gap > 0
    ? "评估器明显高估，优先沉淀负样本"
    : "评估器明显低估，优先沉淀正样本";
  if (remainingReviews(run) > 0) return `还有 ${remainingReviews(run)} 张卡没有人工分`;
  if (run.traceStatus !== "ready") return "链路未就绪，复盘时缺少生成过程";
  if (runCasebookCount(run) > 0) return "已有样本，可以继续扩充备注或对照同类卡";
  return "暂无高优先级问题";
}

function runStatusLabel(run: RunSummary): string {
  if (isEmptyCompletedRun(run)) return "空结果";
  return {
    completed: "已完成",
    failed: "失败",
    queued: "排队中",
    running: "正在生成",
    succeeded: "已完成",
  }[run.status ?? ""] ?? (run.status || "-");
}

export function runStatusClass(run: RunSummary): StatusPillTone {
  if (isEmptyCompletedRun(run)) return "empty";
  return statusPillTones.has(run.status ?? "") ? run.status as StatusPillTone : "neutral";
}

export function traceCell(run: RunSummary): { className: StatusPillTone; label: string } {
  if (isEmptyCompletedRun(run)) return { className: "empty", label: "无卡片" };
  return {
    className: Object.prototype.hasOwnProperty.call(traceStatusLabels, run.traceStatus) ? run.traceStatus : "neutral",
    label: traceStatusLabel(run.traceStatus),
  };
}

function traceStatusLabel(status: RunSummary["traceStatus"] | string | null | undefined): string {
  return typeof status === "string" ? traceStatusLabels[status] ?? "未知" : "未知";
}

export function runMatchesFocus(run: RunSummary, focus: FocusMode): boolean {
  if (focus === "in_progress") return isGenerationTaskRow(run);
  if (focus === "empty_results") return isEmptyCompletedRun(run);
  if (isInFlightRun(run) && focus === "needs_review") return true;
  if (isEmptyCompletedRun(run)) return focus === "all";
  if (focus === "needs_review") return remainingReviews(run) > 0;
  if (focus === "trace_missing") return runCardCount(run) > 0 && run.traceStatus !== "ready";
  if (focus === "eval_gap") return evaluatorGapMagnitude(run) >= 3;
  if (focus === "has_cases") return runCasebookCount(run) > 0;
  return true;
}

const focusOptions: Array<{ label: string; mode: FocusMode }> = [
  { label: "全部", mode: "all" },
  { label: "生成中", mode: "in_progress" },
  { label: "待评审", mode: "needs_review" },
  { label: "空结果", mode: "empty_results" },
  { label: "缺链路", mode: "trace_missing" },
  { label: "分差大", mode: "eval_gap" },
  { label: "有样本", mode: "has_cases" },
];

function isGeneratorAgentRun(run: AgentRunSummary): boolean {
  return run.kind === "generator.manual" || run.kind === "generator.auto";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function runSummaries(value: unknown): RunSummary[] {
  return Array.isArray(value)
    ? value.filter((run): run is RunSummary => {
        if (!isRecord(run)) return false;
        return typeof run.id === "string" && typeof run.runId === "string";
      })
    : [];
}

export function agentRunSummaries(value: unknown): AgentRunSummary[] {
  return Array.isArray(value)
    ? value.filter((run): run is AgentRunSummary => {
        if (!isRecord(run)) return false;
        return typeof run.id === "string" && typeof run.kind === "string" && typeof run.status === "string";
      })
    : [];
}

export function activeGenerationStatusText(runs: Array<Pick<AgentRunSummary, "status">>): string {
  const inFlight = runs.filter((run) => run.status === "queued" || run.status === "running").length;
  const recentlySettled = runs.length - inFlight;
  if (inFlight > 0 && recentlySettled > 0) {
    return `${inFlight} 个生成任务正在运行或排队，${recentlySettled} 个刚完成或失败。`;
  }
  if (inFlight > 0) return `${inFlight} 个生成任务正在运行或排队。`;
  if (recentlySettled > 0) return `${recentlySettled} 个生成任务刚完成或失败，批次列表正在刷新。`;
  return "没有生成任务正在运行或排队。";
}

export function agentRunToSummary(run: AgentRunSummary): RunSummary {
  return {
    id: run.id,
    runId: run.id,
    status: run.status,
    trigger: run.trigger ?? (run.kind === "generator.auto" ? "auto" : "manual"),
    startedAt: run.startedAt ?? run.createdAt,
    completedAt: run.completedAt,
    cardCount: 0,
    avgUserReward: null,
    avgReviewerReward: null,
    deadCardRate: null,
    ahaRate: null,
    reviewedCount: 0,
    casebookCount: 0,
    avgEvaluatorOverall: null,
    traceStatus: "pending",
    reviewLatencyHours: null,
    attempts: run.attempts,
    maxAttempts: run.maxAttempts,
    lastError: run.lastError,
  };
}

function runIdentityKeys(run: Pick<RunSummary, "id" | "runId">): string[] {
  return Array.from(new Set([run.id, run.runId].filter((value) => value.trim().length > 0)));
}

export function mergeActiveAndPersistedRuns(activeSummaries: RunSummary[], persistedRuns: RunSummary[]): RunSummary[] {
  const persistedKeys = new Set(persistedRuns.flatMap(runIdentityKeys));
  const unresolvedActiveRuns = activeSummaries.filter((run) =>
    runIdentityKeys(run).every((key) => !persistedKeys.has(key)),
  );
  return [...unresolvedActiveRuns, ...persistedRuns];
}

function runsQueryKey(query: RunsQueryState): string {
  return JSON.stringify(query);
}

function isCurrentLoadedRunsQuery(currentQueryKey: string, loadedQueryKey: string | null): boolean {
  return loadedQueryKey !== null && loadedQueryKey === currentQueryKey;
}

export function runsBlockingError(
  error: string | null,
  visibleRunCount: number,
  currentQueryKey = "",
  loadedQueryKey: string | null = null,
  filterValidationError: string | null = null,
): boolean {
  void currentQueryKey;
  if (filterValidationError) return false;
  return error !== null && loadedQueryKey === null && visibleRunCount === 0;
}

export function runsRefreshErrorText(
  error: string | null,
  persistedRunCount: number,
  currentQueryKey = "",
  loadedQueryKey: string | null = null,
): string | null {
  void persistedRunCount;
  if (!error || loadedQueryKey === null) return null;
  if (isCurrentLoadedRunsQuery(currentQueryKey, loadedQueryKey)) {
    return `生成批次刷新失败，当前仍显示上一次成功加载的数据：${error}`;
  }
  return `生成批次刷新失败，当前筛选还没有成功加载结果：${error}`;
}

export function runsHideStaleRows(currentQueryKey: string, loadedQueryKey: string | null): boolean {
  return loadedQueryKey !== null && !isCurrentLoadedRunsQuery(currentQueryKey, loadedQueryKey);
}

export function runsInitialLoading(
  loading: boolean,
  loadedQueryKey: string | null,
  visibleRunCount = 0,
): boolean {
  return loading && loadedQueryKey === null && visibleRunCount === 0;
}

export function runsTableEmptyMessage(
  loadingChangedQuery: boolean,
  changedQueryError: boolean,
  filterValidationError: string | null = null,
): string {
  if (filterValidationError) return "当前筛选条件无效，请先修正。";
  if (loadingChangedQuery) return "正在读取当前筛选下的生成批次。";
  if (changedQueryError) return "当前筛选加载失败，请调整筛选后重试。";
  return "当前筛选条件下没有批次。";
}

export function runsFilterError({
  since,
  trigger = "",
  until,
}: Pick<RunsQueryState, "since" | "until"> & Partial<Pick<RunsQueryState, "trigger">>): string | null {
  return textFilterLengthError(trigger, "触发来源") ?? dateRangeOrderError(since, until, "完成时间");
}

function upsertActiveRun(runs: AgentRunSummary[], next: AgentRunSummary): AgentRunSummary[] {
  const filtered = runs.filter((run) => run.id !== next.id);
  return [next, ...filtered];
}

export function RunsView({ onNavigate }: RunsViewProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRuns, setActiveRuns] = useState<AgentRunSummary[]>([]);
  const [reviewed, setReviewed] = useState<"" | "true" | "false">("");
  const [trigger, setTrigger] = useState("");
  const [quality, setQuality] = useState<"" | "aha" | "dead" | "reviewer_aha">("");
  const [focusMode, setFocusMode] = useState<FocusMode>("needs_review");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateMessage, setGenerateMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [activeRunsError, setActiveRunsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedRunsQueryKey, setLoadedRunsQueryKey] = useState<string | null>(null);
  const activePollSeq = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const currentRunsQueryKey = runsQueryKey({ quality, reviewed, since, trigger, until });
  const filterValidationError = runsFilterError({ since, trigger, until });

  function scheduleRefresh(delayMs: number) {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
    }
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      setRefreshNonce((value) => value + 1);
    }, delayMs);
  }

  useEffect(() => () => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestQueryKey = currentRunsQueryKey;
    if (runs.length === 0 || !isCurrentLoadedRunsQuery(currentRunsQueryKey, loadedRunsQueryKey)) setLoading(true);
    setError(null);
    if (filterValidationError) {
      setLoading(false);
      setError(filterValidationError);
      return () => {
        cancelled = true;
      };
    }
    listRuns({
      limit: 80,
      trigger: trigger || undefined,
      reviewed: reviewed === "" ? undefined : reviewed === "true",
      quality: quality || undefined,
      since: dayStartIso(since),
      until: dayEndIso(until),
    })
      .then((data) => {
        if (cancelled) return;
        setRuns(runSummaries(data.runs));
        setLoadedRunsQueryKey(requestQueryKey);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentRunsQueryKey, refreshNonce]);

  useEffect(() => {
    let cancelled = false;
    async function loadActive() {
      const requestId = activePollSeq.current + 1;
      activePollSeq.current = requestId;
      try {
        const data = await listActiveAgentRuns();
        if (cancelled || requestId !== activePollSeq.current) return;
        const generatorRuns = agentRunSummaries(data.runs).filter(isGeneratorAgentRun);
        setActiveRuns(generatorRuns);
        setActiveRunsError(null);
        if (generatorRuns.length > 0) {
          setRefreshNonce((value) => value + 1);
        }
      } catch (err) {
        if (!cancelled && requestId === activePollSeq.current) {
          setActiveRunsError(err instanceof Error ? err.message : "未知错误");
        }
      }
    }

    void loadActive();
    const timer = window.setInterval(() => {
      void loadActive();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function runGenerate() {
    setGenerateBusy(true);
    setGenerateMessage(null);
    try {
      const result = await triggerGenerate(8);
      const now = new Date().toISOString();
      setActiveRuns((current) => upsertActiveRun(current, {
        id: result.taskId,
        kind: "generator.manual",
        status: result.status === "running" ? "running" : "queued",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: result.asOf ?? now,
        attempts: 0,
        maxAttempts: MANUAL_GENERATOR_MAX_ATTEMPTS,
        lastError: null,
        progress: {},
        payload: { cardsToGenerate: 8 },
      }));
      setFocusMode("in_progress");
      setGenerateMessage({
        kind: "status",
        text: result.deduped
          ? `已有生成任务在跑：${result.taskId}`
          : `已触发生成：${result.taskId}`,
      });
      scheduleRefresh(1200);
    } catch (err) {
      setGenerateMessage({
        kind: "error",
        text: err instanceof Error ? `触发失败：${err.message}` : "触发失败",
      });
    } finally {
      setGenerateBusy(false);
    }
  }

  const visibleRuns = useMemo(() => {
    const activeSummaries = activeRuns.map(agentRunToSummary);
    const persistedRuns = runsHideStaleRows(currentRunsQueryKey, loadedRunsQueryKey) ? [] : runs;
    return mergeActiveAndPersistedRuns(activeSummaries, persistedRuns);
  }, [activeRuns, currentRunsQueryKey, loadedRunsQueryKey, runs]);
  const displayRuns = visibleRuns.filter((run) => runMatchesFocus(run, focusMode));
  const hideStaleRows = runsHideStaleRows(currentRunsQueryKey, loadedRunsQueryKey);
  const hasCurrentPersistedRuns = !hideStaleRows && loadedRunsQueryKey !== null;
  const loadingChangedQuery = !hasCurrentPersistedRuns && loadedRunsQueryKey !== null && error === null;
  const changedQueryError = hideStaleRows && error !== null;
  const currentRuns = hideStaleRows ? [] : runs;
  const focusCounts: Record<FocusMode, number> = {
    all: visibleRuns.length,
    in_progress: visibleRuns.filter(isGenerationTaskRow).length,
    needs_review: visibleRuns.filter((run) => isInFlightRun(run) || (!isEmptyCompletedRun(run) && remainingReviews(run) > 0)).length,
    empty_results: visibleRuns.filter(isEmptyCompletedRun).length,
    trace_missing: visibleRuns.filter((run) => runCardCount(run) > 0 && run.traceStatus !== "ready").length,
    eval_gap: visibleRuns.filter((run) => evaluatorGapMagnitude(run) >= 3).length,
    has_cases: visibleRuns.filter((run) => runCasebookCount(run) > 0).length,
  };

  if (runsBlockingError(error, visibleRuns.length, currentRunsQueryKey, loadedRunsQueryKey, filterValidationError)) {
    return (
      <div className="stack">
        <div className="view-toolbar">
          <button className="plain-button" onClick={() => setRefreshNonce((value) => value + 1)} type="button">
            <RefreshCw size={16} /> 重新加载
          </button>
          <div className="toolbar-actions">
            <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.casebook)} type="button">
              <CheckCircle2 size={16} /> 样本库
            </button>
            <button className="plain-button" onClick={() => onNavigate(dashboardRoutes.personalData)} type="button">
              <Database size={16} /> 上下文
            </button>
          </div>
        </div>
        <StateBlock title="生成批次加载失败" detail={error ?? undefined} />
      </div>
    );
  }
  if (runsInitialLoading(loading, loadedRunsQueryKey, visibleRuns.length)) {
    return <StateBlock title="正在加载生成批次" />;
  }

  return (
    <div className="stack">
      <MetricStrip runs={currentRuns} />
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>生成批次</h2>
            <p>当前显示 {displayRuns.length} / {visibleRuns.length} 个批次。生成中的任务会先出现在列表里，完成后自动刷新卡片数。</p>
          </div>
          <div className="filter-row">
            <button className="primary-button" onClick={() => void runGenerate()} disabled={generateBusy} type="button">
              <Sparkles size={15} /> {generateBusy ? "触发中" : "触发生成"}
            </button>
            <button className="plain-button" onClick={() => setRefreshNonce((value) => value + 1)} disabled={loading} type="button">
              <RefreshCw size={15} /> 刷新批次
            </button>
            <input
              aria-label="触发来源筛选"
              maxLength={REWARD_TEXT_FILTER_MAX_LENGTH}
              value={trigger}
              onChange={(event) => setTrigger(event.target.value)}
              placeholder="触发来源"
            />
            <select
              aria-label="评审状态筛选"
              value={reviewed}
              onChange={(event) => setReviewed(event.target.value as "" | "true" | "false")}
            >
              <option value="">全部</option>
              <option value="true">已评审</option>
              <option value="false">未评审</option>
            </select>
            <select
              aria-label="质量筛选"
              value={quality}
              onChange={(event) => setQuality(
                event.target.value as "" | "aha" | "dead" | "reviewer_aha",
              )}
            >
              <option value="">全部质量</option>
              <option value="aha">用户 AHA</option>
              <option value="reviewer_aha">人工 AHA</option>
              <option value="dead">废卡</option>
            </select>
            <input
              aria-label="完成时间晚于"
              type="date"
              value={since}
              max={until || undefined}
              onChange={(event) => setSince(event.target.value)}
              title="完成时间晚于"
            />
            <input
              aria-label="完成时间早于"
              type="date"
              value={until}
              min={since || undefined}
              onChange={(event) => setUntil(event.target.value)}
              title="完成时间早于"
            />
          </div>
        </div>
        {filterValidationError && <div className="inline-error" role="alert">{filterValidationError}</div>}
        {activeRunsError && (
          <div className="inline-error" role="alert">
            生成任务状态刷新失败：{activeRunsError}
          </div>
        )}
        {!filterValidationError && runsRefreshErrorText(error, currentRuns.length, currentRunsQueryKey, loadedRunsQueryKey) && (
          <div className="inline-error" role="alert">
            {runsRefreshErrorText(error, currentRuns.length, currentRunsQueryKey, loadedRunsQueryKey)}
          </div>
        )}
        {generateMessage && (
          <div
            className={generateMessage.kind === "error" ? "inline-error" : "inline-status"}
            role={generateMessage.kind === "error" ? "alert" : "status"}
          >
            {generateMessage.text}
          </div>
        )}
        <div className="focus-tabs" aria-label="批次筛选">
          {focusOptions.map((option) => (
            <button
              key={option.mode}
              aria-pressed={focusMode === option.mode}
              className={focusMode === option.mode ? "active" : ""}
              onClick={() => setFocusMode(option.mode)}
              type="button"
            >
              <span>{option.label}</span>
              <strong>{focusCounts[option.mode]}</strong>
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table aria-label="生成批次列表">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">触发</th>
                <th scope="col">状态</th>
                <th scope="col">批次</th>
                <th scope="col">卡片</th>
                <th scope="col">评审</th>
                <th scope="col">评估分</th>
                <th scope="col">用户分</th>
                <th scope="col">人工分</th>
                <th scope="col">分差</th>
                <th scope="col">废卡</th>
                <th scope="col">AHA</th>
                <th scope="col">链路</th>
                <th scope="col">样本</th>
                <th scope="col">有效信号</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {displayRuns.map((run) => (
                <tr key={runStableKey(run)}>
                  <td>{formatCompactDateTime(run.completedAt ?? run.startedAt)}</td>
                  <td>{run.trigger ?? "-"}</td>
                  <td><span className={`status-pill ${runStatusClass(run)}`}>{runStatusLabel(run)}</span></td>
                  <td className="mono-cell">{shortRunId(run)}</td>
                  <td>{runCardCount(run)}</td>
                  <td>
                    <div className="mini-progress">
                      <span>{runReviewedCount(run)}/{runCardCount(run)}</span>
                      <div><i style={{ width: `${reviewPercent(run)}%` }} /></div>
                    </div>
                  </td>
                  <td>{scoreLabel(run.avgEvaluatorOverall)}</td>
                  <td>{scoreLabel(run.avgUserReward)}</td>
                  <td>{scoreLabel(run.avgReviewerReward)}</td>
                  <td className={evaluatorGapMagnitude(run) >= 3 ? "danger-cell" : ""}>
                    {scoreLabel(evaluatorGap(run))}
                  </td>
                  <td>{percentLabel(run.deadCardRate)}</td>
                  <td>{percentLabel(run.ahaRate)}</td>
                  <td>
                    <span className={`status-pill ${traceCell(run).className}`}>
                      {traceCell(run).label}
                    </span>
                  </td>
                  <td>{runCasebookCount(run)}</td>
                  <td className="signal-cell">{signalText(run)}</td>
                  <td className="row-actions">
                    <button
                      className="row-action-text"
                      onClick={() => onNavigate(dashboardRoutes.run(runDetailRouteId(run)))}
                      title={canOpenRunArtifacts(run) ? "打开批次" : dashboardRouteDisabledReason("run")}
                      disabled={!canOpenRunArtifacts(run)}
                      type="button"
                    >
                      <Eye size={16} />
                      <span>详情</span>
                    </button>
                    <button
                      className="row-action-text"
                      onClick={() => onNavigate(dashboardRoutes.trace(runTraceRouteId(run)))}
                      title={canOpenRunTrace(run) ? "打开生成链路" : dashboardRouteDisabledReason("trace")}
                      disabled={!canOpenRunTrace(run)}
                      type="button"
                    >
                      <GitBranch size={16} />
                      <span>链路</span>
                    </button>
                  </td>
                </tr>
              ))}
              {displayRuns.length === 0 && (
                <tr>
                  <td colSpan={16}>
                    <div className="muted">{runsTableEmptyMessage(loadingChangedQuery, changedQueryError, filterValidationError)}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
