import { describe, expect, it, vi } from "vitest";
import {
  canExportCasebookPage,
  casebookBlockingError,
  casebookCopyUnavailableMessage,
  casebookFilterError,
  casebookHideStaleRows,
  casebookItems,
  casebookLabelDisplay,
  casebookLabelTone,
  casebookMutationCardId,
  casebookRefreshErrorText,
  casebookScoreFilterError,
  casebookSources,
  casebookTableEmptyMessage,
  caseGap,
  caseGapMagnitude,
  scoreFilterNumber,
} from "./CasebookView";
import { REWARD_TEXT_FILTER_MAX_LENGTH } from "@/api/reward";
import type { CasebookEntry } from "@/api/reward";

vi.mock("@/auth/supabase", () => ({
  accessToken: async () => "test-token",
  refreshAccessToken: async () => "test-token",
}));

function casebook(overrides: Partial<CasebookEntry> = {}): CasebookEntry {
  return {
    id: "case_1",
    runId: "run_1",
    cardId: "card_1",
    label: "great",
    scoreSnapshot: 8,
    reviewerNote: null,
    snapshot: {
      card: { id: "card_1", title: "Card" },
      evaluation: {
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
        overall: 4,
        pass: true,
        evaluator: null,
        feedback: null,
        evaluatedAt: null,
      },
    },
    createdAt: "2026-05-14T10:00:00.000Z",
    updatedAt: "2026-05-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("CasebookView scoring helpers", () => {
  it("keeps signed casebook gaps for row display", () => {
    expect(caseGap(casebook({ scoreSnapshot: 8 }))).toBe(-4);
    expect(caseGap(casebook({ scoreSnapshot: 2 }))).toBe(2);
  });

  it("ignores non-finite casebook scores before calculating gaps", () => {
    const baseEvaluation = casebook().snapshot.evaluation;
    expect(caseGap(casebook({ scoreSnapshot: Number.NaN }))).toBeNull();
    expect(caseGap(casebook({
      scoreSnapshot: null,
      snapshot: {
        card: { id: "card_1" },
        evaluation: {
          ...baseEvaluation!,
          overall: Number.NaN,
        },
        rewards: {
          userReward: Number.POSITIVE_INFINITY,
          reviewerReward: Number.NaN,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
      },
    }))).toBeNull();
  });

  it("uses absolute casebook gap magnitude for aggregate disagreement", () => {
    expect(caseGapMagnitude(casebook({ scoreSnapshot: 8 }))).toBe(4);
    expect(caseGapMagnitude(casebook({ scoreSnapshot: 2 }))).toBe(2);
    expect(caseGapMagnitude(casebook({ scoreSnapshot: null, snapshot: { card: { id: "card_1" }, evaluation: null } }))).toBeNull();
  });
});

describe("CasebookView export readiness", () => {
  it("prevents exporting stale rows while the current page is loading", () => {
    expect(canExportCasebookPage([casebook()], true)).toBe(false);
  });

  it("prevents exporting stale rows after a refresh error", () => {
    expect(canExportCasebookPage([casebook()], false, "network failed")).toBe(false);
  });

  it("requires at least one loaded sample before export", () => {
    expect(canExportCasebookPage([], false)).toBe(false);
    expect(canExportCasebookPage([casebook()], false)).toBe(true);
  });

  it("explains why a casebook page cannot be copied", () => {
    expect(casebookCopyUnavailableMessage(false, null, "最低保存分必须是 0 到 10 之间的数字。")).toBe(
      "当前筛选条件无效，先修正后再复制。",
    );
    expect(casebookCopyUnavailableMessage(true, null, null)).toBe("正在读取当前页样本，加载完成后再复制。");
    expect(casebookCopyUnavailableMessage(false, "network failed", null)).toBe("当前页刷新失败，先重新加载成功后再复制。");
    expect(casebookCopyUnavailableMessage(false, null, null)).toBe("当前页没有可复制样本。");
  });
});

describe("CasebookView mutation ids", () => {
  it("falls back to the snapshot card id for casebook mutations", () => {
    expect(casebookMutationCardId(casebook({ cardId: " card_top " }))).toBe("card_top");
    expect(casebookMutationCardId(casebook({
      cardId: "   ",
      snapshot: { card: { id: " card_snapshot " }, evaluation: null },
    }))).toBe("card_snapshot");
    expect(casebookMutationCardId(casebook({
      cardId: "   ",
      snapshot: { evaluation: null },
    }))).toBe("");
  });
});

describe("CasebookView label display", () => {
  it("keeps unknown API labels neutral and bounded", () => {
    expect(casebookLabelDisplay("great")).toBe("好样本");
    expect(casebookLabelTone("great")).toBe("good");
    expect(casebookLabelDisplay("hallucinated")).toBe("幻觉");
    expect(casebookLabelTone("hallucinated")).toBe("bad");
    expect(casebookLabelTone("unknown_label")).toBe("neutral");
    expect(casebookLabelDisplay("unknown label ".repeat(20))).toContain("...");
    expect(casebookLabelDisplay(null)).toBe("未知标签");
  });
});

describe("CasebookView evidence helpers", () => {
  it("uses only runtime string-array sources", () => {
    expect(casebookSources(casebook({
      snapshot: {
        sources: ["memory[1]", 12, null, "feedback[2]"] as unknown as string[],
        card: { id: "card_1", sources: ["card-source"] },
        evaluation: null,
      },
    }))).toEqual(["memory[1]", "feedback[2]"]);
    expect(casebookSources(casebook({
      snapshot: {
        sources: "memory[1]" as unknown as string[],
        card: { id: "card_1", sources: ["card-source"] },
        evaluation: null,
      },
    }))).toEqual(["card-source"]);
    expect(casebookSources(casebook({
      snapshot: {
        sources: [],
        card: { id: "card_1", sources: ["card-source"] },
        evaluation: null,
      },
    }))).toEqual([]);
  });
});

describe("CasebookView runtime array boundaries", () => {
  it("keeps malformed runtime casebook arrays out of table state", () => {
    expect(casebookItems([
      casebook({ id: "case_1" }),
      null,
      { id: "missing_snapshot", runId: "run_1", cardId: "card_1", label: "great" },
      { id: 42, runId: "run_1", cardId: "card_1", label: "great", snapshot: {} },
    ])).toEqual([casebook({ id: "case_1" })]);
    expect(casebookItems("bad")).toEqual([]);
  });
});

describe("CasebookView refresh errors", () => {
  it("blocks the page only before the first successful load", () => {
    expect(casebookBlockingError("network failed", false)).toBe(true);
    expect(casebookBlockingError("network failed", true, "same", "same")).toBe(false);
    expect(casebookBlockingError(null, false)).toBe(false);
    expect(casebookBlockingError(
      "最低保存分必须是 0 到 10 之间的数字。",
      false,
      "new-filters",
      null,
      "最低保存分必须是 0 到 10 之间的数字。",
    )).toBe(false);
  });

  it("keeps controls visible when a changed query fails after a previous load", () => {
    expect(casebookBlockingError("network failed", true, "new-filters", "old-filters")).toBe(false);
  });

  it("hides stale rows as soon as the visible query changes", () => {
    expect(casebookHideStaleRows(true, "new-filters", "old-filters")).toBe(true);
    expect(casebookHideStaleRows(true, "same", "same")).toBe(false);
    expect(casebookHideStaleRows(false, "new-filters", "old-filters")).toBe(false);
  });

  it("distinguishes loading, failed, and genuinely empty casebook table states", () => {
    expect(casebookTableEmptyMessage(true, false)).toBe("正在读取样本库");
    expect(casebookTableEmptyMessage(false, true)).toBe("当前筛选加载失败，请调整筛选后重试。");
    expect(casebookTableEmptyMessage(false, false)).toBe("当前筛选下没有保存样本。");
    expect(casebookTableEmptyMessage(false, true, "最低保存分必须是 0 到 10 之间的数字。")).toBe("当前筛选条件无效，请先修正。");
  });

  it("keeps later refresh failures local to the existing casebook context", () => {
    expect(casebookRefreshErrorText("network failed", false)).toBeNull();
    expect(casebookRefreshErrorText(null, true, "same", "same")).toBeNull();
    expect(casebookRefreshErrorText("network failed", true, "same", "same")).toBe(
      "样本库刷新失败，当前仍显示上一次成功加载的数据：network failed",
    );
    expect(casebookRefreshErrorText("network failed", true, "new-filters", "old-filters")).toBe(
      "样本库刷新失败，当前筛选还没有成功加载结果：network failed",
    );
  });
});

describe("CasebookView score filters", () => {
  it("accepts only finite score filters in the backend-supported range", () => {
    expect(scoreFilterNumber("")).toBeUndefined();
    expect(scoreFilterNumber("7.5")).toBe(7.5);
    expect(scoreFilterNumber("0")).toBe(0);
    expect(scoreFilterNumber("10")).toBe(10);
    expect(scoreFilterNumber("11")).toBeUndefined();
    expect(scoreFilterNumber("-1")).toBeUndefined();
    expect(scoreFilterNumber("Infinity")).toBeUndefined();
  });

  it("reports the first invalid score filter instead of silently dropping it", () => {
    expect(casebookScoreFilterError({ minScore: "11", maxScore: "", minEvaluatorGap: "" })).toBe(
      "最低保存分必须是 0 到 10 之间的数字。",
    );
    expect(casebookScoreFilterError({ minScore: "", maxScore: "12", minEvaluatorGap: "" })).toBe(
      "最高保存分必须是 0 到 10 之间的数字。",
    );
    expect(casebookScoreFilterError({ minScore: "", maxScore: "", minEvaluatorGap: "12" })).toBe(
      "最小评估器分差必须是 0 到 10 之间的数字。",
    );
    expect(casebookScoreFilterError({ minScore: "8", maxScore: "5", minEvaluatorGap: "" })).toBe(
      "最低保存分不能大于最高保存分。",
    );
    expect(casebookScoreFilterError({ minScore: "7", maxScore: "10", minEvaluatorGap: "2" })).toBeNull();
  });

  it("reports reversed updated-at filters before requesting a misleading empty page", () => {
    expect(casebookFilterError({
      basket: "",
      intent: "",
      minScore: "",
      maxScore: "",
      minEvaluatorGap: "",
      since: "2026-05-15",
      until: "2026-05-14",
    })).toBe("样本更新时间开始日期不能晚于结束日期。");
  });

  it("reports oversized text filters before requesting a misleading unfiltered page", () => {
    expect(casebookFilterError({
      basket: "x".repeat(REWARD_TEXT_FILTER_MAX_LENGTH + 1),
      intent: "",
      minScore: "",
      maxScore: "",
      minEvaluatorGap: "",
      since: "",
      until: "",
    })).toBe(`领域筛选不能超过 ${REWARD_TEXT_FILTER_MAX_LENGTH} 个字符。`);
    expect(casebookFilterError({
      basket: "",
      intent: "x".repeat(REWARD_TEXT_FILTER_MAX_LENGTH + 1),
      minScore: "",
      maxScore: "",
      minEvaluatorGap: "",
      since: "",
      until: "",
    })).toBe(`意图筛选不能超过 ${REWARD_TEXT_FILTER_MAX_LENGTH} 个字符。`);
  });
});
