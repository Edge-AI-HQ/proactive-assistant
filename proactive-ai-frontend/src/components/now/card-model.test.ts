import { describe, expect, test } from "vitest";

import type { IntentCard } from "@pin-ai/core";

import { realIntentToChatCard } from "./card-model";

function makeCard(overrides: Partial<IntentCard> = {}): IntentCard {
  return {
    id: "card-1",
    goalBasket: "work",
    title: "AI 新闻",
    whyNow: "今日要闻",
    summary: "今日要闻",
    primaryAction: { label: "查看", type: "confirm" },
    secondaryActions: [],
    confidence: 0.7,
    urgency: 0.5,
    importance: 0.6,
    sources: ["gmail", "calendar"],
    agentChain: [],
    createdAt: "",
    ...overrides,
  };
}

describe("realIntentToChatCard scheduled provenance", () => {
  test("shows 'Scheduled · <label>' in line2 for scheduled cards", () => {
    const chatCard = realIntentToChatCard(
      makeCard({ sourceKind: "scheduled", sourceLabel: "AI 新闻卡片" }),
    );
    expect(chatCard.line2).toBe("Scheduled · AI 新闻卡片");
  });

  test("falls back to the sources line for non-scheduled cards", () => {
    const chatCard = realIntentToChatCard(makeCard());
    expect(chatCard.line2).toBe("Sources: gmail · calendar");
  });
});
