import { describe, expect, it, vi } from "vitest";
import { stageHighlights, traceCopyUnavailableMessage, tracePlainSummary, traceRecoveryVisible } from "./TraceView";
import type { RunDetail, TraceArtifact } from "@/api/reward";

vi.mock("@/auth/supabase", () => ({
  accessToken: async () => "test-token",
  refreshAccessToken: async () => "test-token",
}));

function trace(overrides: Partial<TraceArtifact> = {}): TraceArtifact {
  return {
    runId: "run_1",
    status: "ready",
    traceTree: {},
    summary: {},
    imageFormat: undefined,
    imagePath: null,
    error: null,
    generatedAt: null,
    ...overrides,
  };
}

describe("TraceView recovery state", () => {
  it("shows recovery actions only when the trace failed before any artifact loaded", () => {
    expect(traceRecoveryVisible("network failed", null)).toBe(true);
    expect(traceRecoveryVisible("network failed", trace())).toBe(false);
    expect(traceRecoveryVisible(null, null)).toBe(false);
  });
});

describe("TraceView copy readiness", () => {
  it("prevents copying stale or empty trace markdown", () => {
    expect(traceCopyUnavailableMessage("### trace", true)).toBe("链路正在刷新，完成后再复制。");
    expect(traceCopyUnavailableMessage("   ", false)).toBe("当前链路没有可复制摘要。");
    expect(traceCopyUnavailableMessage("### trace", false)).toBeNull();
  });
});

describe("TraceView readable summary", () => {
  function runWithEvaluation(evaluation: RunDetail["cards"][number]["evaluation"]): RunDetail {
    return {
      ok: true,
      run: {
        id: "run_pk_1",
        runId: "root_run_1",
        status: "completed",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      cards: [{
        card: { id: "card_1", title: "Review the launch checklist" },
        evaluation,
        rewards: {
          userReward: 0,
          reviewerReward: null,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
        rewardHistory: [],
        casebook: null,
        feedbackEvents: [],
      }],
      trace: null,
    };
  }

  it("does not describe missing evaluator scores as dash-point scores", () => {
    const run = runWithEvaluation(null);

    const summary = tracePlainSummary(run, ["memory"], "ready");
    const evaluatorHighlights = stageHighlights("evaluator", {}, run, []);

    expect(summary).toContain("第一张卡还没有保存评估器分");
    expect(evaluatorHighlights).toContain("第一张卡还没有保存评估器分。");
    expect(summary).not.toContain("评为 - 分");
    expect(evaluatorHighlights.join(" ")).not.toContain("评估器分数：-");
  });
});
