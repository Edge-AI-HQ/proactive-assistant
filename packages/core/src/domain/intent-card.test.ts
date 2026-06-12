import { describe, expect, test } from "vitest";

import { normalizeIntentCard } from "./intent-card";

describe("normalizeIntentCard", () => {
  test("preserves backend intentKey for feedback fanout", () => {
    expect(
      normalizeIntentCard({
        id: "card-1",
        intentKey: "work:review-pr",
        goalBasket: "work",
        title: "Review PR",
        whyNow: "Waiting for review",
        primaryAction: { label: "Review", type: "confirm" },
      }).intentKey,
    ).toBe("work:review-pr");
  });

  test("preserves scheduled source provenance", () => {
    const card = normalizeIntentCard({
      id: "card-1",
      goalBasket: "work",
      title: "AI 新闻",
      whyNow: "今日 AI 要闻",
      primaryAction: { label: "查看", type: "confirm" },
      sourceKind: "scheduled",
      sourceLabel: "AI 新闻卡片",
    });
    expect(card.sourceKind).toBe("scheduled");
    expect(card.sourceLabel).toBe("AI 新闻卡片");
  });

  test("omits source provenance when the backend doesn't send it", () => {
    const card = normalizeIntentCard({
      id: "card-1",
      goalBasket: "work",
      title: "x",
      whyNow: "y",
      primaryAction: { label: "z", type: "confirm" },
    });
    expect(card.sourceKind).toBeUndefined();
    expect(card.sourceLabel).toBeUndefined();
  });
});
