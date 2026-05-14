import { describe, expect, it } from "vitest";
import type { RunSummary } from "@/api/reward";
import { finiteScore, runCardCount, runCasebookCount, runEvaluatorGap, runReviewedCount } from "./runSummary";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run_1",
    runId: "trace_1",
    status: "completed",
    trigger: "manual",
    startedAt: null,
    completedAt: null,
    cardCount: 8,
    avgUserReward: 6,
    avgReviewerReward: null,
    deadCardRate: null,
    ahaRate: null,
    reviewedCount: 4,
    casebookCount: 2,
    avgEvaluatorOverall: 7,
    traceStatus: "ready",
    reviewLatencyHours: null,
    ...overrides,
  };
}

describe("run summary numeric boundaries", () => {
  it("clamps untrusted count fields before display math", () => {
    expect(runCardCount(run({ cardCount: Number.NaN }))).toBe(0);
    expect(runCardCount(run({ cardCount: -2 }))).toBe(0);
    expect(runReviewedCount(run({ cardCount: 3, reviewedCount: 9 }))).toBe(3);
    expect(runReviewedCount(run({ reviewedCount: Number.POSITIVE_INFINITY }))).toBe(0);
    expect(runCasebookCount(run({ casebookCount: -1 }))).toBe(0);
  });

  it("ignores non-finite scores in evaluator gap math", () => {
    expect(finiteScore(Number.NaN)).toBeNull();
    expect(runEvaluatorGap(run({ avgEvaluatorOverall: Number.NaN, avgReviewerReward: 5 }))).toBeNull();
    expect(runEvaluatorGap(run({ avgEvaluatorOverall: 9, avgReviewerReward: Number.POSITIVE_INFINITY }))).toBe(3);
    expect(runEvaluatorGap(run({ avgEvaluatorOverall: 9, avgReviewerReward: 5 }))).toBe(4);
  });
});
