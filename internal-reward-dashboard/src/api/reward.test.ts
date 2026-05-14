import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiErrorMessage,
  buildTrace,
  cardReviewMarkdown,
  CASEBOOK_OFFSET_MAX,
  CASEBOOK_REVIEWER_NOTE_MAX_LENGTH,
  casebookMarkdown,
  deleteCasebook,
  getMetrics,
  getCard,
  getPersonalData,
  getRun,
  listActiveAgentRuns,
  listCasebook,
  listRuns,
  PERSONAL_DATA_OFFSET_MAX,
  PERSONAL_DATA_QUERY_MAX_LENGTH,
  percentLabel,
  REWARD_TEXT_FILTER_MAX_LENGTH,
  runReviewMarkdown,
  SCORE_REASON_MAX_LENGTH,
  scoreCard,
  scoreLabel,
  triggerGenerate,
  upsertCasebook,
} from "./reward";
import type { CardDetail, CasebookEntry, CasebookLabel, RunDetail } from "./reward";

const authMocks = vi.hoisted(() => ({
  accessToken: vi.fn(async () => "test-token"),
  refreshAccessToken: vi.fn(async () => "test-token"),
}));

vi.mock("@/auth/supabase", () => ({
  accessToken: authMocks.accessToken,
  refreshAccessToken: authMocks.refreshAccessToken,
}));

afterEach(() => {
  vi.restoreAllMocks();
  authMocks.accessToken.mockReset();
  authMocks.accessToken.mockResolvedValue("test-token");
  authMocks.refreshAccessToken.mockReset();
  authMocks.refreshAccessToken.mockResolvedValue("test-token");
});

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  return new Headers(headers).get(name);
}

describe("reward api formatting", () => {
  it("formats score and percent labels", () => {
    expect(scoreLabel(8)).toBe("8.0");
    expect(scoreLabel(null)).toBe("-");
    expect(percentLabel(0.375)).toBe("38%");
    expect(percentLabel(0)).toBe("0%");
    expect(percentLabel(1)).toBe("100%");
    expect(percentLabel(Number.NaN)).toBe("-");
    expect(percentLabel(-0.1)).toBe("-");
    expect(percentLabel(1.1)).toBe("-");
  });

  it("formats structured API errors without exposing raw JSON", () => {
    expect(apiErrorMessage(404, JSON.stringify({ detail: "run not found" }))).toBe("run not found");
    expect(apiErrorMessage(
      422,
      JSON.stringify({ detail: [{ loc: ["query", "limit"], msg: "Input should be <= 100" }] }),
    )).toBe("query.limit: Input should be <= 100");
    expect(apiErrorMessage(500, "")).toBe("HTTP 500");
  });

  it("rejects blank route ids before calling detail APIs", () => {
    expect(() => getRun("   ")).toThrow("批次 ID 缺失");
    expect(() => buildTrace("   ")).toThrow("批次 ID 缺失");
    expect(() => getCard("   ")).toThrow("卡片 ID 缺失");
    expect(() => scoreCard("   ", 8)).toThrow("卡片 ID 缺失");
    expect(() => upsertCasebook("   ", "great", "")).toThrow("卡片 ID 缺失");
    expect(() => deleteCasebook("   ")).toThrow("卡片 ID 缺失");
  });

  it("coerces trace rebuild force to a boolean before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, trace: null }),
    } as Response);

    await buildTrace("run_1", true);
    await buildTrace("run_2", "yes" as unknown as boolean);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ force: true });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ force: false });
  });

  it("exports casebook markdown", () => {
    const item: CasebookEntry = {
      id: "case_1",
      runId: "run_1",
      cardId: "card_1",
      label: "great",
      scoreSnapshot: 8,
      reviewerNote: "sharp",
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
      snapshot: {
        card: { id: "card_1", title: "AHA card", summary: "summary", sources: ["memory[1] useful detail"] },
        evaluation: null,
        rewards: {
          userReward: 0,
          reviewerReward: 8,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
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
        sources: ["memory[1] useful detail"],
      },
    };
    expect(casebookMarkdown([item])).toContain("### AHA card");
    expect(casebookMarkdown([item])).toContain("- 标签: 好样本");
    expect(casebookMarkdown([item])).toContain("- 卡片详情: /cards/card_1");
    expect(casebookMarkdown([item])).toContain("- 原批次: /runs/run_pk_1");
    expect(casebookMarkdown([item])).toContain("- 生成链路: /traces/root_run_1");
    expect(casebookMarkdown([item])).toContain("- memory[1] useful detail");
    expect(casebookMarkdown([item])).toContain("评审备注: sharp");
  });

  it("keeps casebook markdown source export safe for malformed runtime sources", () => {
    const item: CasebookEntry = {
      id: "case_1",
      runId: "run_1",
      cardId: "card_1",
      label: "great",
      scoreSnapshot: 8,
      reviewerNote: null,
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
      snapshot: {
        card: { id: "card_1", title: "AHA card", sources: ["card-source", 42] as unknown as string[] },
        evaluation: null,
        sources: "bad-source" as unknown as string[],
      },
    };

    const markdown = casebookMarkdown([item]);

    expect(markdown).toContain("- card-source");
    expect(markdown).not.toContain("bad-source");
  });

  it("falls back to raw casebook labels in markdown when the backend enum drifts", () => {
    const item: CasebookEntry = {
      id: "case_1",
      runId: "run_1",
      cardId: "card_1",
      label: "new_label" as CasebookEntry["label"],
      scoreSnapshot: 8,
      reviewerNote: null,
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
      snapshot: {
        card: { id: "card_1", title: "AHA card", summary: "summary", sources: [] },
        evaluation: null,
      },
    };

    const markdown = casebookMarkdown([item]);

    expect(markdown).toContain("- 标签: new_label");
    expect(markdown).not.toContain("undefined");
  });

  it("redacts sensitive-looking unknown casebook labels before markdown export", () => {
    const item: CasebookEntry = {
      id: "case_1",
      runId: "run_1",
      cardId: "card_1",
      label: "api_key=secret-label-token" as CasebookEntry["label"],
      scoreSnapshot: 8,
      reviewerNote: null,
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
      snapshot: {
        card: { id: "card_1", title: "AHA card", summary: "summary", sources: [] },
        evaluation: null,
      },
    };

    const markdown = casebookMarkdown([item]);

    expect(markdown).toContain("- 标签: api_key=已隐藏敏感值");
    expect(markdown).not.toContain("secret-label-token");
  });


  it("marks missing casebook route links as unavailable in markdown exports", () => {
    const item: CasebookEntry = {
      id: "case_1",
      runId: "   ",
      cardId: "   ",
      label: "great",
      scoreSnapshot: 8,
      reviewerNote: null,
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
      snapshot: {
        card: { id: "   ", title: "AHA card", summary: "summary", sources: [] },
        evaluation: null,
        run: {
          id: "   ",
          runId: "   ",
          status: "completed",
          trigger: "manual",
          startedAt: null,
          completedAt: null,
          totalIterations: null,
          error: null,
        },
      },
    };

    const markdown = casebookMarkdown([item]);

    expect(markdown).toContain("- 卡片 ID: 未保存");
    expect(markdown).toContain("- 卡片详情: 未保存");
    expect(markdown).toContain("- 原批次: 未保存");
    expect(markdown).toContain("- 生成链路: 未保存");
  });

  it("uses snapshot card ids for casebook markdown card links when the row id is missing", () => {
    const item: CasebookEntry = {
      id: "case_1",
      runId: "run_1",
      cardId: "   ",
      label: "great",
      scoreSnapshot: 8,
      reviewerNote: null,
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
      snapshot: {
        card: { id: " snapshot_card_1 ", title: "AHA card", summary: "summary", sources: [] },
        evaluation: null,
      },
    };

    const markdown = casebookMarkdown([item]);

    expect(markdown).toContain("- 卡片 ID: snapshot_card_1");
    expect(markdown).toContain("- 卡片详情: /cards/snapshot_card_1");
  });

  it("marks truncated casebook evidence in markdown exports", () => {
    const item: CasebookEntry = {
      id: "case_1",
      runId: "run_1",
      cardId: "card_1",
      label: "great",
      scoreSnapshot: 8,
      reviewerNote: null,
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
      snapshot: {
        card: {
          id: "card_1",
          title: "AHA card",
          summary: "summary",
          sources: Array.from({ length: 6 }, (_, index) => `memory[${index + 1}] useful detail`),
        },
        evaluation: null,
      },
    };

    const markdown = casebookMarkdown([item]);

    expect(markdown).toContain("- memory[5] useful detail");
    expect(markdown).not.toContain("- memory[6] useful detail");
    expect(markdown).toContain("还有 1 条证据未写入复制摘要");
  });

  it("clips oversized casebook markdown fields to keep exports reviewable", () => {
    const longText = "long evidence ".repeat(80);
    const item: CasebookEntry = {
      id: "case_1",
      runId: "run_1",
      cardId: "card_1",
      label: "great",
      scoreSnapshot: 8,
      reviewerNote: "note detail ".repeat(90),
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
      snapshot: {
        card: {
          id: "card_1",
          title: "title detail ".repeat(40),
          summary: "summary detail ".repeat(90),
          sources: [longText],
        },
        evaluation: null,
      },
    };

    const markdown = casebookMarkdown([item]);

    expect(markdown).toContain("...");
    expect(markdown).not.toContain("title detail ".repeat(40).trim());
    expect(markdown).not.toContain(longText.trim());
    expect(markdown).not.toContain("summary detail ".repeat(80).trim());
    expect(markdown).not.toContain("note detail ".repeat(80).trim());
  });

  it("exports single card review markdown", () => {
    const detail: CardDetail = {
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
      card: {
        id: "card_1",
        title: "AHA card",
        summary: "summary",
        whyNow: "why now",
        sources: ["memory[1] useful detail"],
      },
      evaluation: {
        cardId: "card_1",
        runId: "root_run_1",
        intentKey: null,
        basket: null,
        dimensions: {
          relevance: 8,
          actionability: 8,
          whyNowClarity: 8,
          novelty: 8,
          decisionCompression: 8,
        },
        overall: 8,
        pass: true,
        evaluator: "eval",
        feedback: "good card",
        evaluatedAt: null,
      },
      rewards: {
        userReward: 0,
        reviewerReward: 9,
        displayReward: 0,
        opened: false,
        latestUserScoreAt: null,
        latestReviewerScoreAt: null,
      },
      rewardHistory: [],
      casebook: null,
      feedbackEvents: [],
      trace: null,
      relatedCards: [],
    };

    const markdown = cardReviewMarkdown(detail);

    expect(markdown).toContain("### 单卡复盘 AHA card");
    expect(markdown).toContain("- 卡片详情: /cards/card_1");
    expect(markdown).toContain("- 原批次: /runs/run_pk_1");
    expect(markdown).toContain("- 生成链路: /traces/root_run_1");
    expect(markdown).toContain("- 人工分: 9.0");
    expect(markdown).toContain("- memory[1] useful detail");
    expect(markdown).toContain("good card");
  });

  it("keeps single-card markdown source export safe for malformed runtime sources", () => {
    const detail: CardDetail = {
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
      card: {
        id: "card_1",
        title: "AHA card",
        sources: "bad-source" as unknown as string[],
      },
      evaluation: null,
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
      trace: null,
      relatedCards: [],
    };

    const markdown = cardReviewMarkdown(detail);

    expect(markdown).toContain("- 没有保存证据引用。");
    expect(markdown).not.toContain("bad-source");
  });

  it("redacts sensitive-looking single-card markdown fields before export", () => {
    const detail: CardDetail = {
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
      card: {
        id: "card_1",
        title: "AHA card",
        summary: "summary api_key=secret-api-key",
        whyNow: "Authorization: Bearer secret-access-token",
        sources: ["https://example.com/callback?access_token=secret-source-token&state=visible"],
      },
      evaluation: {
        cardId: "card_1",
        runId: "root_run_1",
        intentKey: null,
        basket: null,
        dimensions: {
          relevance: 8,
          actionability: 8,
          whyNowClarity: 8,
          novelty: 8,
          decisionCompression: 8,
        },
        overall: 8,
        pass: true,
        evaluator: "eval",
        feedback: JSON.stringify({ refresh_token: "secret-refresh-token", label: "visible feedback" }),
        evaluatedAt: null,
      },
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
      trace: null,
      relatedCards: [],
    };

    const markdown = cardReviewMarkdown(detail);

    expect(markdown).toContain("已隐藏敏感值");
    expect(markdown).toContain("state=visible");
    expect(markdown).toContain("visible feedback");
    expect(markdown).not.toContain("secret-api-key");
    expect(markdown).not.toContain("secret-access-token");
    expect(markdown).not.toContain("secret-source-token");
    expect(markdown).not.toContain("secret-refresh-token");
  });

  it("marks truncated single-card evidence in markdown exports", () => {
    const detail: CardDetail = {
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
      card: {
        id: "card_1",
        title: "AHA card",
        summary: "summary",
        sources: Array.from({ length: 7 }, (_, index) => `memory[${index + 1}] useful detail`),
      },
      evaluation: null,
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
      trace: null,
      relatedCards: [],
    };

    const markdown = cardReviewMarkdown(detail);

    expect(markdown).toContain("- memory[6] useful detail");
    expect(markdown).not.toContain("- memory[7] useful detail");
    expect(markdown).toContain("还有 1 条证据未写入复制摘要");
  });

  it("clips oversized single-card markdown fields", () => {
    const longSource = "memory very long source ".repeat(80);
    const detail: CardDetail = {
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
      card: {
        id: "card_1",
        title: "title detail ".repeat(40),
        summary: "summary detail ".repeat(90),
        whyNow: "why now detail ".repeat(90),
        sources: [longSource],
      },
      evaluation: {
        cardId: "card_1",
        runId: "root_run_1",
        intentKey: null,
        basket: null,
        dimensions: {
          relevance: 8,
          actionability: 8,
          whyNowClarity: 8,
          novelty: 8,
          decisionCompression: 8,
        },
        overall: 8,
        pass: true,
        evaluator: "eval",
        feedback: "feedback detail ".repeat(90),
        evaluatedAt: null,
      },
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
      trace: null,
      relatedCards: [],
    };

    const markdown = cardReviewMarkdown(detail);

    expect(markdown).toContain("...");
    expect(markdown).not.toContain("title detail ".repeat(40).trim());
    expect(markdown).not.toContain(longSource.trim());
    expect(markdown).not.toContain("summary detail ".repeat(80).trim());
    expect(markdown).not.toContain("why now detail ".repeat(80).trim());
    expect(markdown).not.toContain("feedback detail ".repeat(80).trim());
  });

  it("marks missing single-card route links as unavailable in markdown exports", () => {
    const detail: CardDetail = {
      ok: true,
      run: {
        id: "   ",
        runId: "   ",
        status: "completed",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      card: {
        id: "   ",
        title: "AHA card",
        summary: "summary",
        sources: [],
      },
      evaluation: null,
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
      trace: null,
      relatedCards: [],
    };

    const markdown = cardReviewMarkdown(detail);

    expect(markdown).toContain("- 卡片 ID: 未保存");
    expect(markdown).toContain("- 卡片详情: 未保存");
    expect(markdown).toContain("- 原批次: 未保存");
    expect(markdown).toContain("- 生成链路: 未保存");
  });

  it("uses route card ids for single-card markdown links when the API card id is missing", () => {
    const detail: CardDetail = {
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
      card: {
        id: "   ",
        title: "AHA card",
        summary: "summary",
        sources: [],
      },
      evaluation: null,
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
      trace: null,
      relatedCards: [],
    };

    const markdown = cardReviewMarkdown(detail, " route_card_1 ");

    expect(markdown).toContain("- 卡片 ID: route_card_1");
    expect(markdown).toContain("- 卡片详情: /cards/route_card_1");
  });

  it("exports run review markdown", () => {
    const detail: RunDetail = {
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
        card: { id: "card_1", title: "AHA card", summary: "summary" },
        evaluation: null,
        rewards: {
          userReward: 0,
          reviewerReward: 9,
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

    const markdown = runReviewMarkdown(detail);

    expect(markdown).toContain("### 批次复盘 root_run_1");
    expect(markdown).toContain("- 批次评审: /runs/run_pk_1");
    expect(markdown).toContain("- 生成链路: /traces/root_run_1");
    expect(markdown).toContain("- 人工评审: 1/1");
    expect(markdown).toContain("1. AHA card");
    expect(markdown).toContain("- 卡片详情: /cards/card_1");
  });

  it("redacts sensitive-looking run status fields before markdown export", () => {
    const detail: RunDetail = {
      ok: true,
      run: {
        id: "run_pk_1",
        runId: "root_run_1",
        status: "failed authorization=secret-status-token",
        trigger: "manual refresh_token=secret-trigger-token",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      cards: [],
      trace: null,
    };

    const markdown = runReviewMarkdown(detail);

    expect(markdown).toContain("已隐藏敏感值");
    expect(markdown).not.toContain("secret-status-token");
    expect(markdown).not.toContain("secret-trigger-token");
  });


  it("does not count malformed reviewer rewards as reviewed in run markdown", () => {
    const detail: RunDetail = {
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
        card: { id: "card_1", title: "AHA card", summary: "summary" },
        evaluation: null,
        rewards: {
          userReward: 0,
          reviewerReward: undefined as unknown as null,
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

    expect(runReviewMarkdown(detail)).toContain("- 人工评审: 0/1");
  });

  it("keeps run markdown safe for malformed runtime card arrays", () => {
    const detail: RunDetail = {
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
      cards: [
        {
          card: { id: "card_1", title: "AHA card", summary: "summary" },
          evaluation: null,
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
        },
        null,
        { card: { id: "missing_rewards" } },
      ] as unknown as RunDetail["cards"],
      trace: null,
    };

    const markdown = runReviewMarkdown(detail);

    expect(markdown).toContain("- 卡片数: 1");
    expect(markdown).toContain("1. AHA card");
    expect(runReviewMarkdown({
      ...detail,
      cards: "bad" as unknown as RunDetail["cards"],
    })).toContain("- 当前批次没有保存卡片。");
  });

  it("marks missing run route links as unavailable in markdown exports", () => {
    const detail: RunDetail = {
      ok: true,
      run: {
        id: "   ",
        runId: "   ",
        status: "completed",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      cards: [{
        card: { id: "   ", title: "AHA card", summary: "summary" },
        evaluation: null,
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

    const markdown = runReviewMarkdown(detail);

    expect(markdown).toContain("### 批次复盘 未保存");
    expect(markdown).toContain("- 批次评审: 未保存");
    expect(markdown).toContain("- 生成链路: 未保存");
    expect(markdown).toContain("- 卡片详情: 未保存");
  });

  it("uses route run ids for run markdown links when persisted run ids are missing", () => {
    const detail: RunDetail = {
      ok: true,
      run: {
        id: "   ",
        runId: "   ",
        status: "completed",
        trigger: "manual",
        startedAt: null,
        completedAt: null,
        totalIterations: null,
        error: null,
      },
      cards: [],
      trace: null,
    };

    const markdown = runReviewMarkdown(detail, " route_run_1 ");

    expect(markdown).toContain("### 批次复盘 route_run_1");
    expect(markdown).toContain("- 批次评审: /runs/route_run_1");
    expect(markdown).toContain("- 生成链路: /traces/route_run_1");
  });

  it("marks truncated run review markdown when a batch has more than eight cards", () => {
    const detail: RunDetail = {
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
      cards: Array.from({ length: 9 }, (_, index) => ({
        card: { id: `card_${index + 1}`, title: `Card ${index + 1}`, summary: `summary ${index + 1}` },
        evaluation: null,
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
      })),
      trace: null,
    };

    const markdown = runReviewMarkdown(detail);

    expect(markdown).toContain("8. Card 8");
    expect(markdown).not.toContain("9. Card 9");
    expect(markdown).toContain("还有 1 张卡未写入复制摘要");
  });

  it("clips oversized run card summaries in markdown exports", () => {
    const detail: RunDetail = {
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
        card: { id: "card_1", title: "title detail ".repeat(40), summary: "summary detail ".repeat(60) },
        evaluation: null,
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

    const markdown = runReviewMarkdown(detail);

    expect(markdown).toContain("...");
    expect(markdown).not.toContain("title detail ".repeat(40).trim());
    expect(markdown).not.toContain("summary detail ".repeat(50).trim());
  });

  it("passes run filters to the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runs: [] }),
    } as Response);

    await listRuns({
      limit: 80,
      trigger: "manual",
      reviewed: false,
      quality: "reviewer_aha",
      since: "2026-05-13T00:00:00.000Z",
      until: "2026-05-13T23:59:59.000Z",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/reward-dashboard/runs?");
    expect(String(url)).toContain("trigger=manual");
    expect(String(url)).toContain("reviewed=false");
    expect(String(url)).toContain("quality=reviewer_aha");
    expect(String(url)).toContain("since=2026-05-13T00%3A00%3A00.000Z");
    expect(String(url)).toContain("until=2026-05-13T23%3A59%3A59.000Z");
    expect(headerValue(init?.headers, "Authorization")).toBe("Bearer test-token");
  });

  it("trims and bounds run string filters before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runs: [] }),
    } as Response);

    await listRuns({
      trigger: "  manual  ",
      since: "  2026-05-13T00:00:00.000Z  ",
      until: "x".repeat(REWARD_TEXT_FILTER_MAX_LENGTH + 1),
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("trigger=manual");
    expect(url).toContain("since=2026-05-13T00%3A00%3A00.000Z");
    expect(url).not.toContain("until=");
  });

  it("omits unknown run quality filters before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runs: [] }),
    } as Response);
    const params = { quality: "unknown_quality" } as unknown as Parameters<typeof listRuns>[0];

    await listRuns(params);

    expect(String(fetchMock.mock.calls[0][0])).not.toContain("quality=");
  });

  it("omits out-of-range list pagination before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runs: [], items: [], sections: [], totals: {} }),
    } as Response);

    await listRuns({ limit: 201 });
    await listCasebook({ limit: 201 });
    await getPersonalData({ limit: 201, offset: PERSONAL_DATA_OFFSET_MAX + 1 });

    expect(String(fetchMock.mock.calls[0][0])).not.toContain("limit=");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("limit=");
    expect(String(fetchMock.mock.calls[2][0])).not.toContain("limit=");
    expect(String(fetchMock.mock.calls[2][0])).not.toContain("offset=");
  });

  it("preserves request headers when adding auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, event: null, card: null }),
    } as Response);

    await scoreCard("card_1", 8);

    const [, init] = fetchMock.mock.calls[0];
    expect(headerValue(init?.headers, "Authorization")).toBe("Bearer test-token");
    expect(headerValue(init?.headers, "Content-Type")).toBe("application/json");
  });

  it("rejects invalid reviewer scores before calling the API", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, event: null, card: null }),
    } as Response);

    expect(() => scoreCard("card_1", Number.NaN)).toThrow("人工评分必须是 1 到 10 之间的数字。");
    expect(() => scoreCard("card_1", 0)).toThrow("人工评分必须是 1 到 10 之间的数字。");
    expect(() => scoreCard("card_1", 11)).toThrow("人工评分必须是 1 到 10 之间的数字。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims mutation text before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, event: null, card: null, casebook: null }),
    } as Response);

    await scoreCard("card_1", 8, " useful evaluator miss ");
    await upsertCasebook("card_1", "great", " strong positive example ");
    await upsertCasebook("card_1", "great", "   ");

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      reason: "useful evaluator miss",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      reviewerNote: "strong positive example",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      reviewerNote: null,
    });
  });

  it("rejects unknown casebook mutation labels before calling the API", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, casebook: null }),
    } as Response);
    const invalidLabel = "unknown_label" as unknown as CasebookLabel;

    expect(() => upsertCasebook("card_1", invalidLabel, "note")).toThrow("样本库标签无效");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized mutation text before calling the API", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, event: null, card: null }),
    } as Response);

    expect(() => scoreCard("card_1", 8, "x".repeat(SCORE_REASON_MAX_LENGTH + 1))).toThrow(
      `评分原因不能超过 ${SCORE_REASON_MAX_LENGTH} 个字符。`,
    );
    expect(() => upsertCasebook("card_1", "great", "x".repeat(CASEBOOK_REVIEWER_NOTE_MAX_LENGTH + 1))).toThrow(
      `样本库评审备注不能超过 ${CASEBOOK_REVIEWER_NOTE_MAX_LENGTH} 个字符。`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves request headers when retrying after token refresh", async () => {
    authMocks.refreshAccessToken.mockResolvedValue("fresh-token");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("invalid Supabase token", { status: 401 }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, event: null, card: null }),
      } as Response);

    await scoreCard("card_1", 8);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1];
    expect(headerValue(retryInit?.headers, "Authorization")).toBe("Bearer fresh-token");
    expect(headerValue(retryInit?.headers, "Content-Type")).toBe("application/json");
  });

  it("passes casebook filters to the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, items: [] }),
    } as Response);

    await listCasebook({
      label: "great",
      minScore: 7.5,
      maxScore: 10,
      basket: "work",
      intent: "ios",
      minEvaluatorGap: 1,
      since: "2026-05-13T00:00:00.000Z",
      until: "2026-05-13T23:59:59.000Z",
      limit: 40,
      offset: 80,
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/reward-dashboard/casebook?");
    expect(String(url)).toContain("label=great");
    expect(String(url)).toContain("minScore=7.5");
    expect(String(url)).toContain("maxScore=10");
    expect(String(url)).toContain("basket=work");
    expect(String(url)).toContain("intent=ios");
    expect(String(url)).toContain("minEvaluatorGap=1");
    expect(String(url)).toContain("limit=40");
    expect(String(url)).toContain("offset=80");
  });

  it("trims and bounds casebook string filters before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, items: [], total: 0, limit: 40, offset: 0 }),
    } as Response);

    await listCasebook({
      label: "  great  ",
      basket: "  work  ",
      intent: "x".repeat(REWARD_TEXT_FILTER_MAX_LENGTH + 1),
      since: "  2026-05-13T00:00:00.000Z  ",
      until: "   ",
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("label=great");
    expect(url).toContain("basket=work");
    expect(url).toContain("since=2026-05-13T00%3A00%3A00.000Z");
    expect(url).not.toContain("intent=");
    expect(url).not.toContain("until=");
  });

  it("omits unknown casebook labels before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, items: [], total: 0, limit: 40, offset: 0 }),
    } as Response);

    await listCasebook({ label: "unknown_label" });

    expect(String(fetchMock.mock.calls[0][0])).not.toContain("label=");
  });

  it("omits invalid numeric casebook filters before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, items: [], total: 0, limit: 40, offset: 0 }),
    } as Response);

    await listCasebook({
      minScore: Number.NaN,
      maxScore: Number.POSITIVE_INFINITY,
      minEvaluatorGap: -1,
      limit: 0,
      offset: -20,
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("minScore=");
    expect(String(url)).not.toContain("maxScore=");
    expect(String(url)).not.toContain("minEvaluatorGap=");
    expect(String(url)).not.toContain("limit=");
    expect(String(url)).not.toContain("offset=");
  });

  it("omits out-of-range casebook offsets before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, items: [], total: 0, limit: 40, offset: 0 }),
    } as Response);

    await listCasebook({ offset: CASEBOOK_OFFSET_MAX + 1 });

    expect(String(fetchMock.mock.calls[0][0])).not.toContain("offset=");
  });

  it("omits out-of-range casebook score filters before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, items: [], total: 0, limit: 40, offset: 0 }),
    } as Response);

    await listCasebook({
      minScore: 11,
      maxScore: 12,
      minEvaluatorGap: 12,
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("minScore=");
    expect(String(url)).not.toContain("maxScore=");
    expect(String(url)).not.toContain("minEvaluatorGap=");
  });

  it("passes personal data pagination to the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, sections: [], totals: {} }),
    } as Response);

    await getPersonalData({
      category: "raw",
      since: "2026-05-14T00:00:00.000Z",
      until: "2026-05-14T23:59:59.999Z",
      q: "gmail",
      limit: 40,
      offset: 80,
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/reward-dashboard/personal-data?");
    expect(String(url)).toContain("category=raw");
    expect(String(url)).toContain("q=gmail");
    expect(String(url)).toContain("limit=40");
    expect(String(url)).toContain("offset=80");
  });

  it("omits unknown personal data categories before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, sections: [], totals: {} }),
    } as Response);
    const params = { category: "unknown_category" } as unknown as Parameters<typeof getPersonalData>[0];

    await getPersonalData(params);

    expect(String(fetchMock.mock.calls[0][0])).not.toContain("category=");
  });

  it("trims and bounds personal data date filters before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, filters: {}, totals: {}, sections: [] }),
    } as Response);

    await getPersonalData({
      since: "  2026-05-13T00:00:00.000Z  ",
      until: "x".repeat(REWARD_TEXT_FILTER_MAX_LENGTH + 1),
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("since=2026-05-13T00%3A00%3A00.000Z");
    expect(url).not.toContain("until=");
  });

  it("trims valid personal data queries and omits overlong queries before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, sections: [], totals: {} }),
    } as Response);

    await getPersonalData({ q: "  gmail  " });
    await getPersonalData({ q: "x".repeat(PERSONAL_DATA_QUERY_MAX_LENGTH + 1) });

    expect(String(fetchMock.mock.calls[0][0])).toContain("q=gmail");
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("q=");
  });

  it("omits invalid numeric personal data filters before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, sections: [], totals: {} }),
    } as Response);

    await getPersonalData({
      limit: Number.NaN,
      offset: -1,
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("limit=");
    expect(String(url)).not.toContain("offset=");
  });

  it("omits invalid metrics windows before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, days: 14, series: [] }),
    } as Response);

    await getMetrics(Number.POSITIVE_INFINITY);
    await getMetrics(91);

    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/reward-dashboard/metrics");
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/reward-dashboard/metrics");
  });

  it("normalizes manual generator count before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, taskId: "gen_1", runId: "gen_1", status: "queued", asOf: "now" }),
    } as Response);

    await triggerGenerate(5);
    await triggerGenerate(Number.NaN);
    await triggerGenerate(11);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ cardsToGenerate: 5 });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ cardsToGenerate: 8 });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ cardsToGenerate: 8 });
  });

  it("loads active agent runs for in-flight generation rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runs: [] }),
    } as Response);

    await listActiveAgentRuns();

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/agent-runs/active");
  });

  it("throws readable JSON detail messages from failed API requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ detail: "reward dashboard unavailable" }),
      { status: 503 },
    ));

    await expect(listRuns()).rejects.toThrow("reward dashboard unavailable");
  });

  it("throws readable validation detail messages from failed API requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        detail: [{ loc: ["query", "limit"], msg: "Input should be less than or equal to 100" }],
      }),
      { status: 422 },
    ));

    await expect(getPersonalData()).rejects.toThrow(
      "query.limit: Input should be less than or equal to 100",
    );
  });
});
