import { afterEach, describe, expect, it, vi } from "vitest";
import {
  casebookMarkdown,
  getPersonalData,
  listActiveAgentRuns,
  listCasebook,
  listRuns,
  percentLabel,
  scoreLabel,
} from "./reward";
import type { CasebookEntry } from "./reward";

vi.mock("@/auth/supabase", () => ({
  accessToken: async () => "test-token",
  refreshAccessToken: async () => "test-token",
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reward api formatting", () => {
  it("formats score and percent labels", () => {
    expect(scoreLabel(8)).toBe("8.0");
    expect(scoreLabel(null)).toBe("-");
    expect(percentLabel(0.375)).toBe("38%");
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
        card: { id: "card_1", title: "AHA card", summary: "summary" },
        evaluation: null,
        rewards: {
          userReward: 0,
          reviewerReward: 8,
          displayReward: 0,
          opened: false,
          latestUserScoreAt: null,
          latestReviewerScoreAt: null,
        },
        sources: [],
      },
    };
    expect(casebookMarkdown([item])).toContain("### AHA card");
    expect(casebookMarkdown([item])).toContain("- 标签: 好样本");
    expect(casebookMarkdown([item])).toContain("评审备注: sharp");
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
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
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

  it("loads active agent runs for in-flight generation rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runs: [] }),
    } as Response);

    await listActiveAgentRuns();

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/agent-runs/active");
  });
});
