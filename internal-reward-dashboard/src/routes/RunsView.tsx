import { useEffect, useMemo, useState } from "react";
import {
  Eye,
  GitBranch,
  Sparkles,
} from "lucide-react";
import { listActiveAgentRuns, listRuns, percentLabel, scoreLabel, triggerGenerate } from "@/api/reward";
import type { AgentRunSummary, RunSummary } from "@/api/reward";
import { MetricStrip } from "@/components/MetricStrip";
import { StateBlock } from "@/components/StateBlock";

interface RunsViewProps {
  onNavigate: (path: string) => void;
}

type FocusMode =
  | "all"
  | "in_progress"
  | "needs_review"
  | "empty_results"
  | "trace_missing"
  | "eval_gap"
  | "has_cases";

function formatCompactDateTime(value: string | null | undefined): string {
  return value
    ? new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
    }).format(new Date(value))
    : "-";
}

function shortRunId(run: RunSummary): string {
  const id = run.runId || run.id;
  return id.length > 16 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function reviewPercent(run: RunSummary): number {
  if (run.cardCount <= 0) return 0;
  return Math.min(100, Math.round((run.reviewedCount / run.cardCount) * 100));
}

function remainingReviews(run: RunSummary): number {
  return Math.max(0, run.cardCount - run.reviewedCount);
}

function isInFlightRun(run: RunSummary): boolean {
  return run.status === "queued" || run.status === "running";
}

function isGenerationTaskRow(run: RunSummary): boolean {
  return isInFlightRun(run) || (
    run.cardCount === 0
    && (run.status === "succeeded" || run.status === "failed")
  );
}

function isEmptyCompletedRun(run: RunSummary): boolean {
  return run.status === "completed" && run.cardCount === 0;
}

function evaluatorGap(run: RunSummary): number | null {
  if (typeof run.avgEvaluatorOverall !== "number") return null;
  const humanScore = run.avgReviewerReward ?? run.avgUserReward;
  if (typeof humanScore !== "number") return null;
  return run.avgEvaluatorOverall - humanScore;
}

function signalText(run: RunSummary): string {
  if (isInFlightRun(run)) return "生成进行中，完成后会自动显示卡片数量和详情";
  if (run.status === "succeeded" && run.cardCount === 0) return "生成刚完成，正在刷新卡片列表";
  if (run.status === "failed" && run.cardCount === 0) return "生成失败，请查看任务日志";
  if (isEmptyCompletedRun(run)) return "生成完成，但没有卡片通过评估或写入 final_cards";
  const signals: string[] = [];
  const gap = evaluatorGap(run);
  if (typeof gap === "number" && gap >= 3) signals.push(`评估分比人工高 ${gap.toFixed(1)}`);
  if ((run.deadCardRate ?? 0) > 0) signals.push(`${percentLabel(run.deadCardRate)} 废卡`);
  if ((run.ahaRate ?? 0) > 0) signals.push(`${percentLabel(run.ahaRate)} AHA`);
  if (run.traceStatus !== "ready") signals.push(`链路${traceStatusLabel(run.traceStatus)}`);
  if (run.casebookCount > 0) signals.push(`${run.casebookCount} 个样本`);
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

function runStatusClass(run: RunSummary): string {
  return isEmptyCompletedRun(run) ? "empty" : (run.status ?? "");
}

function traceCell(run: RunSummary): { className: string; label: string } {
  if (isEmptyCompletedRun(run)) return { className: "empty", label: "无卡片" };
  return { className: run.traceStatus, label: traceStatusLabel(run.traceStatus) };
}

function traceStatusLabel(status: RunSummary["traceStatus"]): string {
  return {
    failed: "失败",
    missing: "缺失",
    pending: "生成中",
    ready: "已就绪",
  }[status];
}

function runMatchesFocus(run: RunSummary, focus: FocusMode): boolean {
  if (focus === "in_progress") return isGenerationTaskRow(run);
  if (focus === "empty_results") return isEmptyCompletedRun(run);
  if (isInFlightRun(run) && focus === "needs_review") return true;
  if (isEmptyCompletedRun(run)) return focus === "all";
  if (focus === "needs_review") return remainingReviews(run) > 0;
  if (focus === "trace_missing") return run.cardCount > 0 && run.traceStatus !== "ready";
  if (focus === "eval_gap") return (evaluatorGap(run) ?? 0) >= 3;
  if (focus === "has_cases") return run.casebookCount > 0;
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

function agentRunToSummary(run: AgentRunSummary): RunSummary {
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
  };
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
  const [generateMessage, setGenerateMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (runs.length === 0) setLoading(true);
    setError(null);
    listRuns({
      limit: 80,
      trigger: trigger || undefined,
      reviewed: reviewed === "" ? undefined : reviewed === "true",
      quality: quality || undefined,
      since: since ? new Date(`${since}T00:00:00`).toISOString() : undefined,
      until: until ? new Date(`${until}T23:59:59`).toISOString() : undefined,
    })
      .then((data) => {
        if (cancelled) return;
        setRuns(data.runs);
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
  }, [trigger, reviewed, quality, since, until, refreshNonce]);

  useEffect(() => {
    let cancelled = false;
    async function loadActive() {
      try {
        const data = await listActiveAgentRuns();
        if (cancelled) return;
        const generatorRuns = data.runs.filter(isGeneratorAgentRun);
        setActiveRuns(generatorRuns);
        if (generatorRuns.length > 0) {
          setRefreshNonce((value) => value + 1);
        }
      } catch {
        if (!cancelled) setActiveRuns([]);
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
        maxAttempts: 3,
        lastError: null,
        progress: {},
        payload: { cardsToGenerate: 8 },
      }));
      setFocusMode("in_progress");
      setGenerateMessage(result.deduped
        ? `已有生成任务在跑：${result.taskId}`
        : `已触发生成：${result.taskId}`);
      setTimeout(() => setRefreshNonce((value) => value + 1), 1200);
    } catch (err) {
      setGenerateMessage(err instanceof Error ? `触发失败：${err.message}` : "触发失败");
    } finally {
      setGenerateBusy(false);
    }
  }

  const visibleRuns = useMemo(() => {
    const activeSummaries = activeRuns.map(agentRunToSummary);
    const activeIds = new Set(activeSummaries.map((run) => run.id));
    return [
      ...activeSummaries,
      ...runs.filter((run) => !activeIds.has(run.id)),
    ];
  }, [activeRuns, runs]);
  const displayRuns = visibleRuns.filter((run) => runMatchesFocus(run, focusMode));
  const focusCounts: Record<FocusMode, number> = {
    all: visibleRuns.length,
    in_progress: visibleRuns.filter(isGenerationTaskRow).length,
    needs_review: visibleRuns.filter((run) => isInFlightRun(run) || (!isEmptyCompletedRun(run) && remainingReviews(run) > 0)).length,
    empty_results: visibleRuns.filter(isEmptyCompletedRun).length,
    trace_missing: visibleRuns.filter((run) => run.cardCount > 0 && run.traceStatus !== "ready").length,
    eval_gap: visibleRuns.filter((run) => (evaluatorGap(run) ?? 0) >= 3).length,
    has_cases: visibleRuns.filter((run) => run.casebookCount > 0).length,
  };

  if (loading) return <StateBlock title="正在加载生成批次" />;
  if (error) return <StateBlock title="生成批次加载失败" detail={error} />;

  return (
    <div className="stack">
      <MetricStrip runs={runs} />
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>生成批次</h2>
            <p>当前显示 {displayRuns.length} / {visibleRuns.length} 个批次。生成中的任务会先出现在列表里，完成后自动刷新卡片数。</p>
          </div>
          <div className="filter-row">
            <button className="primary-button" onClick={() => void runGenerate()} disabled={generateBusy}>
              <Sparkles size={15} /> {generateBusy ? "触发中" : "触发生成"}
            </button>
            <input
              value={trigger}
              onChange={(event) => setTrigger(event.target.value)}
              placeholder="触发来源"
            />
            <select
              value={reviewed}
              onChange={(event) => setReviewed(event.target.value as "" | "true" | "false")}
            >
              <option value="">全部</option>
              <option value="true">已评审</option>
              <option value="false">未评审</option>
            </select>
            <select
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
              type="date"
              value={since}
              onChange={(event) => setSince(event.target.value)}
              title="完成时间晚于"
            />
            <input
              type="date"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              title="完成时间早于"
            />
          </div>
        </div>
        {generateMessage && <div className="inline-status">{generateMessage}</div>}
        <div className="focus-tabs" aria-label="批次筛选">
          {focusOptions.map((option) => (
            <button
              key={option.mode}
              className={focusMode === option.mode ? "active" : ""}
              onClick={() => setFocusMode(option.mode)}
            >
              <span>{option.label}</span>
              <strong>{focusCounts[option.mode]}</strong>
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>触发</th>
                <th>状态</th>
                <th>批次</th>
                <th>卡片</th>
                <th>评审</th>
                <th>评估分</th>
                <th>用户分</th>
                <th>人工分</th>
                <th>分差</th>
                <th>废卡</th>
                <th>AHA</th>
                <th>链路</th>
                <th>样本</th>
                <th>有效信号</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {displayRuns.map((run) => (
                <tr key={run.id}>
                  <td>{formatCompactDateTime(run.completedAt ?? run.startedAt)}</td>
                  <td>{run.trigger ?? "-"}</td>
                  <td><span className={`status-pill ${runStatusClass(run)}`}>{runStatusLabel(run)}</span></td>
                  <td className="mono-cell">{shortRunId(run)}</td>
                  <td>{run.cardCount}</td>
                  <td>
                    <div className="mini-progress">
                      <span>{run.reviewedCount}/{run.cardCount}</span>
                      <div><i style={{ width: `${reviewPercent(run)}%` }} /></div>
                    </div>
                  </td>
                  <td>{scoreLabel(run.avgEvaluatorOverall)}</td>
                  <td>{scoreLabel(run.avgUserReward)}</td>
                  <td>{scoreLabel(run.avgReviewerReward)}</td>
                  <td className={(evaluatorGap(run) ?? 0) >= 3 ? "danger-cell" : ""}>
                    {scoreLabel(evaluatorGap(run))}
                  </td>
                  <td>{percentLabel(run.deadCardRate)}</td>
                  <td>{percentLabel(run.ahaRate)}</td>
                  <td>
                    <span className={`status-pill ${traceCell(run).className}`}>
                      {traceCell(run).label}
                    </span>
                  </td>
                  <td>{run.casebookCount}</td>
                  <td className="signal-cell">{signalText(run)}</td>
                  <td className="row-actions">
                    <button
                      className="row-action-text"
                      onClick={() => onNavigate(`/runs/${run.id}`)}
                      title="打开批次"
                      disabled={isInFlightRun(run)}
                    >
                      <Eye size={16} />
                      <span>详情</span>
                    </button>
                    <button
                      className="row-action-text"
                      onClick={() => onNavigate(`/traces/${run.runId}`)}
                      title="打开生成链路"
                      disabled={isInFlightRun(run)}
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
                    <div className="muted">当前筛选条件下没有批次。</div>
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
