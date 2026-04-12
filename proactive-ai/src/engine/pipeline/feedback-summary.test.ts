// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listFeedback, feedbackStats } = vi.hoisted(() => ({
  listFeedback: vi.fn(),
  feedbackStats: vi.fn(),
}));

vi.mock("./data-access.js", () => ({
  listFeedback,
  feedbackStats,
}));

import {
  formatRecentFeedbackSummary,
  loadRecentFeedbackSummary,
} from "./feedback-summary.js";

describe("feedback-summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when there are no recent actionable signals", async () => {
    listFeedback.mockResolvedValueOnce([]);
    feedbackStats.mockResolvedValueOnce({ totalCount: 0 });

    const summary = await loadRecentFeedbackSummary();

    expect(summary).toBeNull();
    expect(formatRecentFeedbackSummary(summary)).toBe("");
  });

  it("extracts confirm, modify, dismiss, and text preference patterns", async () => {
    listFeedback.mockResolvedValueOnce([
      {
        id: "fe_1",
        kind: "card_action",
        action: "confirm",
        basket: "work",
        createdAt: "2026-04-07T09:00:00.000Z",
        metadata: { intentKey: "work:review-queue-with-alex" },
      },
      {
        id: "fe_2",
        kind: "card_action",
        action: "confirm",
        basket: "work",
        createdAt: "2026-04-06T09:00:00.000Z",
        metadata: { intentKey: "work:review-queue-with-alex" },
      },
      {
        id: "fe_3",
        kind: "card_action",
        action: "modify",
        basket: "health",
        createdAt: "2026-04-05T09:00:00.000Z",
        metadata: { intentKey: "health:adjust-evening-walk-plan" },
      },
      {
        id: "fe_4",
        kind: "dismiss",
        basket: "life",
        createdAt: "2026-04-04T09:00:00.000Z",
        metadata: { intentKey: "life:review-weekend-plan" },
      },
      {
        id: "fe_5",
        kind: "text_feedback",
        basket: "work",
        source: "user_derived",
        text: "Prefer morning work briefings",
        createdAt: "2026-04-07T08:00:00.000Z",
        metadata: {},
      },
    ]);
    feedbackStats.mockResolvedValueOnce({ totalCount: 5 });

    const summary = await loadRecentFeedbackSummary({ since: "14d" });

    expect(summary).not.toBeNull();
    expect(summary?.confirmPatterns).toEqual([
      {
        basket: "work",
        count: 2,
        intentKeys: ["work:review-queue-with-alex"],
      },
    ]);
    expect(summary?.modifyPatterns).toEqual([
      {
        basket: "health",
        count: 1,
        intentKeys: ["health:adjust-evening-walk-plan"],
      },
    ]);
    expect(summary?.dismissPatterns).toEqual([
      {
        basket: "life",
        count: 1,
        intentKeys: ["life:review-weekend-plan"],
      },
    ]);
    expect(summary?.textPreferences).toEqual(["Prefer morning work briefings"]);

    const promptText = formatRecentFeedbackSummary(summary);
    expect(promptText).toContain("Recent feedback window: last 14d");
    expect(promptText).toContain("Frequently confirmed");
    expect(promptText).toContain("Frequently modified");
    expect(promptText).toContain("Frequently dismissed");
    expect(promptText).toContain("Prefer morning work briefings");
  });

  it("surfaces sustained card-chat interest derived from agent analysis", async () => {
    listFeedback.mockResolvedValueOnce([
      {
        id: "fe_chat_1",
        kind: "text_feedback",
        source: "agent_analysis",
        basket: "work",
        text: "User kept drilling into the executable hiring follow-up.",
        createdAt: "2026-04-07T09:00:00.000Z",
        metadata: {
          analysisType: "card_chat_interest",
          intentKey: "work:draft-hiring-outreach",
          topics: ["hiring", "follow-up"],
          nextAngles: ["draft outreach", "schedule follow-up"],
        },
      },
    ]);
    feedbackStats.mockResolvedValueOnce({ totalCount: 1 });

    const summary = await loadRecentFeedbackSummary({ since: "14d" });
    const promptText = formatRecentFeedbackSummary(summary);

    expect(promptText).toContain("Sustained card chats: work cards (1)");
    expect(promptText).toContain("work:draft-hiring-outreach");
    expect(promptText).toContain("Chat-derived topics: hiring | follow-up");
    expect(promptText).toContain("Chat-derived follow-up angles: draft outreach | schedule follow-up");
  });
});
