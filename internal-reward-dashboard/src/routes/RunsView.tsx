import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Database,
  Eye,
  GitBranch,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import { listActiveAgentRuns, listRuns, percentLabel, scoreLabel, triggerGenerate } from "@/api/reward";
import type { AgentRunSummary, RunSummary } from "@/api/reward";
import { StateBlock } from "@/components/StateBlock";
import { dashboardRouteDisabledReason, dashboardRoutes, firstDashboardRouteId, hasDashboardRouteId } from "@/lib/dashboardRoutes";
import { formatDateTimeOrDash } from "@/lib/dateFormat";
import { dateRangeOrderError, dayEndIso, dayStartIso } from "@/lib/dateRange";
import { runCardCount, runCasebookCount, runEvaluatorGap, runReviewedCount } from "@/lib/runSummary";
import { REWARD_TEXT_FILTER_MAX_LENGTH, textFilterLengthError } from "@/lib/textFilter";

interface RunsViewProps {
  onNavigate: (path: string) => void;
}

export interface RunsQueryState {
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

interface RunsWorkloadSummary {
  casebookRuns: number;
  emptyRuns: number;
  evaluatorGapRuns: number;
  inProgressRuns: number;
  pendingReviews: number;
  reviewRuns: number;
  traceMissingRuns: number;
}

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

export function runsWorkloadSummary(runs: RunSummary[]): RunsWorkloadSummary {
  return {
    casebookRuns: runs.filter((run) => runCasebookCount(run) > 0).length,
    emptyRuns: runs.filter(isEmptyCompletedRun).length,
    evaluatorGapRuns: runs.filter((run) => evaluatorGapMagnitude(run) >= 3).length,
    inProgressRuns: runs.filter(isGenerationTaskRow).length,
    pendingReviews: runs.reduce((sum, run) => sum + remainingReviews(run), 0),
    reviewRuns: runs.filter((run) => !isEmptyCompletedRun(run) && remainingReviews(run) > 0).length,
    traceMissingRuns: runs.filter((run) => runCardCount(run) > 0 && run.traceStatus !== "ready").length,
  };
}

export function primaryWorkloadAction(summary: RunsWorkloadSummary): { detail: string; label: string } {
  if (summary.pendingReviews > 0) {
    return {
      label: "先评最新卡片",
      detail: `${summary.reviewRuns} 个批次还有 ${summary.pendingReviews} 张卡没人工判断${summary.inProgressRuns > 0 ? `，另有 ${summary.inProgressRuns} 个生成任务在跑` : ""}。`,
    };
  }
  if (summary.inProgressRuns > 0) {
    return {
      label: "先等生成落库",
      detail: `${summary.inProgressRuns} 个生成任务还在跑，列表会自动把占位行合并到真实批次。`,
    };
  }
  if (summary.traceMissingRuns > 0) {
    return {
      label: "补齐链路记录",
      detail: `${summary.traceMissingRuns} 个批次缺 trace，先修可追溯性。`,
    };
  }
  return {
    label: "整理样本库",
    detail: `${summary.casebookRuns} 个批次已有样本，可以继续沉淀好坏案例。`,
  };
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

const emptyRunsQueryState: RunsQueryState = {
  quality: "",
  reviewed: "",
  since: "",
  trigger: "",
  until: "",
};

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

export function runsQueryEquals(left: RunsQueryState, right: RunsQueryState): boolean {
  return runsQueryKey(left) === runsQueryKey(right);
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
  const [appliedFilters, setAppliedFilters] = useState<RunsQueryState>(emptyRunsQueryState);
  const [draftFilters, setDraftFilters] = useState<RunsQueryState>(emptyRunsQueryState);
  const [focusMode, setFocusMode] = useState<FocusMode>("all");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateMessage, setGenerateMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const [activeRunsError, setActiveRunsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedRunsQueryKey, setLoadedRunsQueryKey] = useState<string | null>(null);
  const activePollSeq = useRef(0);
  const refreshTimer = useRef<number | null>(null);
  const currentRunsQueryKey = runsQueryKey(appliedFilters);
  const filterValidationError = runsFilterError(appliedFilters);
  const draftFilterValidationError = runsFilterError(draftFilters);
  const hasDraftFilterChanges = !runsQueryEquals(draftFilters, appliedFilters);

  function updateDraftFilter<Key extends keyof RunsQueryState>(key: Key, value: RunsQueryState[Key]) {
    setDraftFilters((current) => ({ ...current, [key]: value }));
  }

  function applyDraftFilters() {
    if (draftFilterValidationError) return;
    setAppliedFilters(draftFilters);
    setRefreshNonce((value) => value + 1);
  }

  function resetFilters() {
    setDraftFilters(emptyRunsQueryState);
    setAppliedFilters(emptyRunsQueryState);
    setRefreshNonce((value) => value + 1);
  }

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
      trigger: appliedFilters.trigger || undefined,
      reviewed: appliedFilters.reviewed === "" ? undefined : appliedFilters.reviewed === "true",
      quality: appliedFilters.quality || undefined,
      since: dayStartIso(appliedFilters.since),
      until: dayEndIso(appliedFilters.until),
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
  const workloadSummary = runsWorkloadSummary(visibleRuns);
  const workloadAction = primaryWorkloadAction(workloadSummary);

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
      <section className="runs-command-grid" aria-label="批次处理摘要">
        <div className="runs-command-primary">
          <div className="eyebrow">建议下一步</div>
          <h2>{workloadAction.label}</h2>
          <p>{workloadAction.detail}</p>
          <div className="runs-command-actions">
            <button className="primary-button" onClick={() => void runGenerate()} disabled={generateBusy} type="button">
              <Sparkles size={15} /> {generateBusy ? "触发中" : "触发生成"}
            </button>
            <button className="plain-button" onClick={() => setRefreshNonce((value) => value + 1)} disabled={loading} type="button">
              <RefreshCw size={15} /> 刷新批次
            </button>
          </div>
        </div>
        <div className="runs-command-stats" aria-label="工作量概览">
          <div className="metric-todo">
            <span>待评审</span>
            <strong>{workloadSummary.pendingReviews}</strong>
            <small>{workloadSummary.reviewRuns} 个批次</small>
          </div>
          <div className="metric-trace">
            <span>缺链路</span>
            <strong>{workloadSummary.traceMissingRuns}</strong>
            <small>需要补 trace</small>
          </div>
          <div className="metric-gap">
            <span>分差大</span>
            <strong>{workloadSummary.evaluatorGapRuns}</strong>
            <small>评估差 3+</small>
          </div>
          <div className="metric-empty">
            <span>空结果</span>
            <strong>{workloadSummary.emptyRuns}</strong>
            <small>无 final cards</small>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head runs-panel-head">
          <div>
            <h2>生成批次</h2>
          </div>
          <div className="runs-toolbar">
            <form
              className="runs-filter-form"
              onSubmit={(event) => {
                event.preventDefault();
                applyDraftFilters();
              }}
            >
              <input
                aria-label="触发来源筛选"
                maxLength={REWARD_TEXT_FILTER_MAX_LENGTH}
                value={draftFilters.trigger}
                onChange={(event) => updateDraftFilter("trigger", event.target.value)}
                placeholder="触发来源"
              />
              <select
                aria-label="评审状态筛选"
                value={draftFilters.reviewed}
                onChange={(event) => updateDraftFilter("reviewed", event.target.value as RunsQueryState["reviewed"])}
              >
                <option value="">全部</option>
                <option value="true">已评审</option>
                <option value="false">未评审</option>
              </select>
              <select
                aria-label="质量筛选"
                value={draftFilters.quality}
                onChange={(event) => updateDraftFilter("quality", event.target.value as RunsQueryState["quality"])}
              >
                <option value="">全部质量</option>
                <option value="aha">用户 AHA</option>
                <option value="reviewer_aha">人工 AHA</option>
                <option value="dead">废卡</option>
              </select>
              <div className="date-range-control" aria-label="完成时间范围">
                <label className="date-range-field">
                  <span>起始</span>
                  <input
                    aria-label="完成时间起始日期"
                    type="date"
                    value={draftFilters.since}
                    max={draftFilters.until || undefined}
                    onChange={(event) => updateDraftFilter("since", event.target.value)}
                  />
                </label>
                <span className="date-range-separator">至</span>
                <label className="date-range-field">
                  <span>结束</span>
                  <input
                    aria-label="完成时间结束日期"
                    type="date"
                    value={draftFilters.until}
                    min={draftFilters.since || undefined}
                    onChange={(event) => updateDraftFilter("until", event.target.value)}
                  />
                </label>
              </div>
              <button className="plain-button search-button" disabled={Boolean(draftFilterValidationError)} type="submit">
                <Search size={15} /> 搜索
              </button>
              <button
                className="plain-button"
                disabled={!hasDraftFilterChanges && runsQueryEquals(appliedFilters, emptyRunsQueryState)}
                onClick={resetFilters}
                type="button"
              >
                <RotateCcw size={15} /> 重置
              </button>
            </form>
          </div>
        </div>
        {draftFilterValidationError && <div className="inline-error" role="alert">{draftFilterValidationError}</div>}
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
        <div className="run-worklist" role="list" aria-label="生成批次列表">
          <div className="run-worklist-head" aria-hidden="true">
            <span>批次 / 信号</span>
            <span>卡片</span>
            <span>评审</span>
            <span>评估</span>
            <span>用户 / 人工</span>
            <span>分差</span>
            <span>废卡 / AHA</span>
            <span>链路</span>
            <span>样本</span>
            <span>操作</span>
          </div>
          {displayRuns.map((run) => (
            <article className="run-worklist-row" key={runStableKey(run)} role="listitem">
              <div className="run-row-main">
                <div className="run-row-heading">
                  <span className={`status-pill ${runStatusClass(run)}`}>{runStatusLabel(run)}</span>
                  <strong className="mono-cell">{shortRunId(run)}</strong>
                  <span>{formatCompactDateTime(run.completedAt ?? run.startedAt)}</span>
                  <span>{run.trigger ?? "-"}</span>
                </div>
                <p>{signalText(run)}</p>
              </div>
              <div className="run-row-metrics" aria-label="批次指标">
                <div>
                  <span>卡片</span>
                  <strong>{runCardCount(run)}</strong>
                </div>
                <div className="run-row-progress">
                  <span>评审</span>
                  <strong>{runReviewedCount(run)}/{runCardCount(run)}</strong>
                  <div className="mini-progress" aria-hidden="true"><div><i style={{ width: `${reviewPercent(run)}%` }} /></div></div>
                </div>
                <div>
                  <span>评估</span>
                  <strong>{scoreLabel(run.avgEvaluatorOverall)}</strong>
                </div>
                <div>
                  <span>用户 / 人工</span>
                  <strong>{scoreLabel(run.avgUserReward)} / {scoreLabel(run.avgReviewerReward)}</strong>
                </div>
                <div>
                  <span>分差</span>
                  <strong className={evaluatorGapMagnitude(run) >= 3 ? "danger-cell" : ""}>
                    {scoreLabel(evaluatorGap(run))}
                  </strong>
                </div>
                <div>
                  <span>废卡 / AHA</span>
                  <strong>{percentLabel(run.deadCardRate)} / {percentLabel(run.ahaRate)}</strong>
                </div>
                <div>
                  <span>链路</span>
                  <strong><span className={`status-pill ${traceCell(run).className}`}>{traceCell(run).label}</span></strong>
                </div>
                <div>
                  <span>样本</span>
                  <strong>{runCasebookCount(run)}</strong>
                </div>
              </div>
              <div className="run-row-actions">
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
              </div>
            </article>
          ))}
          {displayRuns.length === 0 && (
            <div className="run-worklist-empty">
              {runsTableEmptyMessage(loadingChangedQuery, changedQueryError, filterValidationError)}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
