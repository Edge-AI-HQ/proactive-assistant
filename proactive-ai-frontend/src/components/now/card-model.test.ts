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

describe("realIntentToChatCard card kind", () => {
  test("stamps cardKind for legacy reminder cards (card-rem- id, no cardKind)", () => {
    // Cards persisted before the cardKind field existed are only
    // recognizable by their id prefix; the string id is lost past this
    // projection (ChatCard.id is numeric), so the kind must be derived
    // here or the chat agent treats the nudge as executable.
    const chatCard = realIntentToChatCard(makeCard({ id: "card-rem-a4bbf49040c6" }));
    expect(chatCard.cardKind).toBe("reminder");
  });

  test("passes scheduleTaskId through for new reminder cards", () => {
    const chatCard = realIntentToChatCard(
      makeCard({
        id: "card-rem-bb1122334455",
        cardKind: "reminder",
        scheduleTaskId: "sched.once.x",
      }),
    );
    expect(chatCard.cardKind).toBe("reminder");
    expect(chatCard.scheduleTaskId).toBe("sched.once.x");
  });

  test("leaves generator cards untyped", () => {
    const chatCard = realIntentToChatCard(makeCard({ id: "gen.auto.1.abc_card_00" }));
    expect(chatCard.cardKind).toBeUndefined();
  });
});
