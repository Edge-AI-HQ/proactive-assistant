import { describe, expect, it, vi } from "vitest";
import {
  cardIndex,
  generationSummary,
  hasReviewerScore,
  runDetailCardSources,
  runDetailCards,
  runCopyUnavailableMessage,
  runDetailCardRouteId,
  runDetailTraceRouteId,
  runDetailRecordCount,
  scoreGap,
  scoreGapMagnitude,
} from "./RunDetailView";
import type { Evaluation, RewardSummary, RunDetail } from "@/api/reward";

vi.mock("@/auth/supabase", () => ({
  accessToken: async () => "test-token",
  refreshAccessToken: async () => "test-token",
}));

function evaluation(overall: number | null): Evaluation {
  return {
    cardId: "card_1",
    runId: "run_1",
    intentKey: null,
    basket: null,
    dimensions: {
      relevance: null,
      actionability: null,
      whyNowClarity: null,
      novelty: null,
      decisionCompression: null,
    },
    overall,
    pass: true,
    evaluator: null,
    feedback: null,
    evaluatedAt: null,
  };
}

function rewards(reviewerReward: number | null): RewardSummary {
  return {
    userReward: 1,
    reviewerReward,
    displayReward: 1,
    opened: true,
    latestUserScoreAt: null,
    latestReviewerScoreAt: null,
  };
}

function card(overrides: Partial<RunDetail["cards"][number]> = {}): RunDetail["cards"][number] {
  return {
    card: { id: "card_1", title: "Card" },
    evaluation: evaluation(8),
    rewards: rewards(5),
    rewardHistory: [],
    casebook: null,
    feedbackEvents: [],
    ...overrides,
  };
}

describe("RunDetailView scoring helpers", () => {
  it("keeps signed evaluator gaps for display", () => {
    expect(scoreGap(card({ evaluation: evaluation(9), rewards: rewards(5) }))).toBe(4);
    expect(scoreGap(card({ evaluation: evaluation(4), rewards: rewards(8) }))).toBe(-4);
  });

  it("uses absolute evaluator gap magnitude for priority sorting", () => {
    const overestimated = card({ evaluation: evaluation(9), rewards: rewards(6) });
    const underestimated = card({ evaluation: evaluation(4), rewards: rewards(8) });
    const aligned = card({ evaluation: evaluation(7), rewards: rewards(6) });

    expect(scoreGapMagnitude(overestimated)).toBe(3);
    expect(scoreGapMagnitude(underestimated)).toBe(4);
    expect([overestimated, underestimated, aligned].sort((a, b) => scoreGapMagnitude(b) - scoreGapMagnitude(a))[0]).toBe(underestimated);
  });

  it("ignores non-finite scores in evaluator gap and review status helpers", () => {
    expect(scoreGap(card({ evaluation: evaluation(Number.NaN), rewards: rewards(5) }))).toBeNull();
    expect(scoreGap(card({ evaluation: evaluation(8), rewards: rewards(Number.POSITIVE_INFINITY) }))).toBe(7);
    expect(scoreGapMagnitude(card({ evaluation: evaluation(Number.NaN), rewards: rewards(5) }))).toBe(0);
    expect(hasReviewerScore(card({ rewards: rewards(7) }))).toBe(true);
    expect(hasReviewerScore(card({ rewards: rewards(Number.NaN) }))).toBe(false);
    expect(hasReviewerScore(card({
      rewards: {
        ...rewards(null),
        reviewerReward: undefined as unknown as null,
      },
    }))).toBe(false);
  });
});

describe("RunDetailView card ordering helpers", () => {
  it("uses object identity before duplicate or blank card ids", () => {
    const first = card({ card: { id: "", title: "First" } });
    const second = card({ card: { id: "", title: "Second" } });
    const third = card({ card: { id: "dup", title: "Third" } });
    const fourth = card({ card: { id: "dup", title: "Fourth" } });
    const cards = [first, second, third, fourth];

    expect(cardIndex(second, cards)).toBe(1);
    expect(cardIndex(fourth, cards)).toBe(3);
  });

  it("falls back to the first matching non-blank card id for copied entries", () => {
    const first = card({ card: { id: "card_1", title: "First" } });
    const second = card({ card: { id: "card_2", title: "Second" } });

    expect(cardIndex(card({ card: { id: " card_2 ", title: "Copy" } }), [first, second])).toBe(1);
    expect(cardIndex(card({ card: { id: "   ", title: "Missing" } }), [first, second])).toBe(0);
  });
});

describe("RunDetailView trace routing", () => {
  it("normalizes card route ids before detail navigation and mutations", () => {
    expect(runDetailCardRouteId(card({ card: { id: " card_1 ", title: "Card" } }))).toBe("card_1");
    expect(runDetailCardRouteId(card({ card: { id: "   ", title: "Card" } }))).toBe("");
  });

  it("prefers root run ids for trace artifacts", () => {
    expect(runDetailTraceRouteId({ id: "run_pk_1", runId: "root_run_1" }, "route_run_1")).toBe("root_run_1");
  });

  it("falls back to the route run id before persisted ids", () => {
    expect(runDetailTraceRouteId({ id: "run_pk_1", runId: "   " }, "route_run_1")).toBe("route_run_1");
    expect(runDetailTraceRouteId({ id: "run_pk_1", runId: "   " }, "   ")).toBe("run_pk_1");
  });
});

describe("RunDetailView card evidence helpers", () => {
  it("normalizes runtime card rows before detail summaries", () => {
    const valid = card({ card: { id: "card_1", title: "Valid" } });

    expect(runDetailCards({
      cards: [
        valid,
        null,
        { card: { id: "missing_rewards" } },
        "bad",
      ] as unknown as RunDetail["cards"],
    })).toEqual([valid]);
    expect(runDetailCards({ cards: "bad" as unknown as RunDetail["cards"] })).toEqual([]);
    expect(runDetailCards(null)).toEqual([]);
  });

  it("accepts only runtime string-array sources", () => {
    expect(runDetailCardSources({ id: "card_1", sources: ["memory[1]", "feedback[2]"] })).toEqual([
      "memory[1]",
      "feedback[2]",
    ]);
    expect(runDetailCardSources({
      id: "card_1",
      sources: ["memory[1]", 42, null, "goal[2]"] as unknown as string[],
    })).toEqual(["memory[1]", "goal[2]"]);
    expect(runDetailCardSources({
      id: "card_1",
      sources: "memory[1]" as unknown as string[],
    })).toEqual([]);
  });

  it("counts only object rows from runtime event arrays", () => {
    expect(runDetailRecordCount([{ id: "one" }, null, "bad", { id: "two" }])).toBe(2);
    expect(runDetailRecordCount("bad")).toBe(0);
  });
});

describe("RunDetailView readable summary", () => {
  function runDetail(cards: RunDetail["cards"]): RunDetail {
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
      cards,
      trace: null,
    };
  }

  it("does not describe missing evaluator scores as dash scores", () => {
    const summary = generationSummary(
      runDetail([card({ evaluation: null })]),
      null,
      ["memory"],
    );

    expect(summary).toContain("还没有保存首张卡的评估器分");
    expect(summary).not.toContain("评估器给到 -");
  });
});

describe("RunDetailView copy readiness", () => {
  it("prevents copying stale or empty run review markdown", () => {
    expect(runCopyUnavailableMessage("### run", "card_1")).toBe("正在保存卡片状态，刷新完成后再复制。");
    expect(runCopyUnavailableMessage("   ", null)).toBe("当前批次没有可复制摘要。");
    expect(runCopyUnavailableMessage("### run", null)).toBeNull();
  });
});
