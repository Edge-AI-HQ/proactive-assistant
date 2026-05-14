import type { RunSummary } from "@/api/reward";
import { finiteCount } from "@/lib/count";

export function runCardCount(run: RunSummary): number {
  return finiteCount(run.cardCount);
}

export function runReviewedCount(run: RunSummary): number {
  return Math.min(runCardCount(run), finiteCount(run.reviewedCount));
}

export function runCasebookCount(run: RunSummary): number {
  return finiteCount(run.casebookCount);
}

export function finiteScore(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function runEvaluatorGap(run: RunSummary): number | null {
  const evaluatorScore = finiteScore(run.avgEvaluatorOverall);
  const humanScore = finiteScore(run.avgReviewerReward) ?? finiteScore(run.avgUserReward);
  return evaluatorScore === null || humanScore === null ? null : evaluatorScore - humanScore;
}
