import test from "node:test";
import assert from "node:assert/strict";

import { normalizeIntentCard, normalizeIntentCards } from "../src/types/intent-card";

test("normalizeIntentCard fills missing arrays and action fields", () => {
  const normalized = normalizeIntentCard({
    id: "card-1",
    goalBasket: "growth",
    title: "Connect personal data sources",
    whyNow: "Composio API key is not configured yet.",
    confidence: 0.95,
    urgency: 0.6,
    importance: 0.9,
  });

  assert.equal(normalized.goalBasket, "growth");
  assert.equal(normalized.summary, "Composio API key is not configured yet.");
  assert.deepEqual(normalized.sources, []);
  assert.deepEqual(normalized.secondaryActions, []);
  assert.deepEqual(normalized.agentChain, []);
  assert.deepEqual(normalized.primaryAction, {
    label: "Review this card",
    type: "modify",
  });
});

test("normalizeIntentCards drops non-object values and preserves valid cards", () => {
  const normalized = normalizeIntentCards([
    null,
    "bad",
    {
      id: "card-2",
      goalBasket: "life",
      title: "Wind down before sleep",
      whyNow: "You have no quiet hours configured.",
      primaryAction: { label: "Set quiet hours", type: "confirm" },
      secondaryActions: [{ label: "Later", type: "snooze" }],
      sources: ["profile"],
      agentChain: ["planner", "generator"],
      confidence: 0.8,
      urgency: 0.7,
      importance: 0.75,
      summary: "Protect evenings by setting a quiet window.",
      createdAt: "2026-04-15",
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.id, "card-2");
  assert.deepEqual(normalized[0]?.sources, ["profile"]);
  assert.deepEqual(normalized[0]?.secondaryActions, [{ label: "Later", type: "snooze" }]);
});
