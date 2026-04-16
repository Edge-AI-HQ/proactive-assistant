import { beforeEach, describe, expect, it, vi } from "vitest";

const { listRecentGeneratedCards } = vi.hoisted(() => ({
  listRecentGeneratedCards: vi.fn(),
}));

vi.mock("./data-access.js", () => ({
  listRecentGeneratedCards,
}));

import { loadRecentGeneratedCardsSummary } from "./generated-cards-summary.js";

describe("loadRecentGeneratedCardsSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes thread decision, latest outcome, chat summary, and next angles when present", async () => {
    listRecentGeneratedCards.mockResolvedValue([
      {
        goalBasket: "work",
        title: "Review queue with Alex",
        titleKey: "review-queue-with-alex",
        generatedAt: "2026-04-10T10:00:00.000Z",
        threadContext: {
          threadDecision: "refine",
          latestCardOutcome: "dismiss",
          latestChatSummary: "The topic still matters, but the action should be narrower.",
          nextAngles: ["batch review", "delegate low-risk PRs"],
        },
      },
    ]);

    const summary = await loadRecentGeneratedCardsSummary({ limit: 10, since: "14d" });

    expect(summary).toContain("review-queue-with-alex");
    expect(summary).toContain("decision=refine");
    expect(summary).toContain("outcome=dismiss");
    expect(summary).toContain("chat=The topic still matters, but the action should be narrower.");
    expect(summary).toContain("next=batch review; delegate low-risk PRs");
  });
});
