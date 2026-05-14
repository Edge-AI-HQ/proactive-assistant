import { describe, expect, it } from "vitest";
import { metricStripCells } from "./MetricStrip";
import type { RunSummary } from "@/api/reward";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run_1",
    runId: "trace_1",
    status: "completed",
    trigger: "manual",
    startedAt: null,
    completedAt: null,
    cardCount: 4,
    avgUserReward: 6,
    avgReviewerReward: null,
    deadCardRate: null,
    ahaRate: null,
    reviewedCount: 4,
    casebookCount: 0,
    avgEvaluatorOverall: 6,
    traceStatus: "ready",
    reviewLatencyHours: null,
    ...overrides,
  };
}

describe("metricStripCells", () => {
  it("does not count empty result runs as trace gaps", () => {
    const cells = metricStripCells([
      run({ id: "empty", cardCount: 0, reviewedCount: 0, traceStatus: "missing" }),
      run({ id: "missing", cardCount: 2, reviewedCount: 2, traceStatus: "missing" }),
      run({ id: "ready", cardCount: 2, reviewedCount: 2, traceStatus: "ready" }),
    ]);

    expect(cells.find((cell) => cell.label === "链路缺失")?.value).toBe("1");
  });

  it("counts evaluator overestimates and underestimates as disagreement", () => {
    const cells = metricStripCells([
      run({ id: "over", avgEvaluatorOverall: 9, avgReviewerReward: 5 }),
      run({ id: "under", avgEvaluatorOverall: 3, avgReviewerReward: 7 }),
      run({ id: "aligned", avgEvaluatorOverall: 7, avgReviewerReward: 6 }),
    ]);

    expect(cells.find((cell) => cell.label === "评估偏差")?.value).toBe("2");
  });

  it("clamps invalid backend counts before computing totals", () => {
    const cells = metricStripCells([
      run({ id: "bad_cards", cardCount: Number.NaN, reviewedCount: 4, traceStatus: "missing" }),
      run({ id: "too_many_reviews", cardCount: 3, reviewedCount: 9 }),
      run({ id: "negative", cardCount: -3, reviewedCount: -2 }),
    ]);

    expect(cells.find((cell) => cell.label === "卡片总数")?.value).toBe("3");
    expect(cells.find((cell) => cell.label === "待评审卡")?.value).toBe("0");
    expect(cells.find((cell) => cell.label === "链路缺失")?.value).toBe("0");
  });

  it("ignores invalid quality rates before averaging percentages", () => {
    const cells = metricStripCells([
      run({ id: "valid", deadCardRate: 0.25, ahaRate: 0.5 }),
      run({ id: "too_high", deadCardRate: 1.2, ahaRate: 2 }),
      run({ id: "negative", deadCardRate: -0.2, ahaRate: -1 }),
    ]);

    expect(cells.find((cell) => cell.label === "废卡率")?.value).toBe("25%");
    expect(cells.find((cell) => cell.label === "AHA 率")?.value).toBe("50%");
  });
});
