import type { RunSummary } from "@/api/reward";
import { percentLabel } from "@/api/reward";
import { runCardCount, runEvaluatorGap, runReviewedCount } from "@/lib/runSummary";

interface MetricStripProps {
  runs: RunSummary[];
}

interface MetricCell {
  hint: string;
  label: string;
  tone: string;
  value: string;
}

function avg(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
  if (nums.length === 0) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

export function metricStripCells(runs: RunSummary[]): MetricCell[] {
  const dead = avg(runs.map((r) => r.deadCardRate));
  const aha = avg(runs.map((r) => r.ahaRate));
  const totalCards = runs.reduce((sum, run) => sum + runCardCount(run), 0);
  const totalReviewed = runs.reduce((sum, run) => sum + runReviewedCount(run), 0);
  const pendingReviews = Math.max(0, totalCards - totalReviewed);
  const traceMissing = runs.filter((run) => runCardCount(run) > 0 && run.traceStatus !== "ready").length;
  const evaluatorGap = runs.filter((run) => Math.abs(runEvaluatorGap(run) ?? 0) >= 3).length;
  return [
    { hint: `${runs.length} 个批次`, label: "卡片总数", tone: "neutral", value: String(totalCards) },
    { hint: `${totalReviewed} 张已评`, label: "待评审卡", tone: pendingReviews > 0 ? "warn" : "good", value: String(pendingReviews) },
    { hint: "不能追溯就先修", label: "链路缺失", tone: traceMissing > 0 ? "bad" : "good", value: String(traceMissing) },
    { hint: "评估分和人工差 3+", label: "评估偏差", tone: evaluatorGap > 0 ? "bad" : "good", value: String(evaluatorGap) },
    { hint: "用户无反馈或低分", label: "废卡率", tone: "neutral", value: percentLabel(dead) },
    { hint: "用户高价值信号", label: "AHA 率", tone: "neutral", value: percentLabel(aha) },
  ];
}

export function MetricStrip({ runs }: MetricStripProps) {
  const cells = metricStripCells(runs);
  return (
    <section className="metric-strip">
      {cells.map((cell) => (
        <div className={`metric-cell ${cell.tone}`} key={cell.label}>
          <div className="metric-label">{cell.label}</div>
          <div className="metric-value">{cell.value}</div>
          <div className="metric-hint">{cell.hint}</div>
        </div>
      ))}
    </section>
  );
}
