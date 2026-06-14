import { describe, expect, test } from "vitest";

import type { IntentCard } from "./intent-card";
import { basketToLovableCategory, djb2, realCardToLovableIntent } from "./lovable-card";

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
    sourceApps: ["gmail", "gcal"],
    reasoningSteps: [],
    agentChain: [],
    createdAt: "",
    ...overrides,
  };
}

describe("djb2", () => {
  test("确定性、非负、不同输入不同输出", () => {
    expect(djb2("card-1")).toBe(djb2("card-1"));
    expect(djb2("card-1")).toBeGreaterThanOrEqual(0);
    expect(djb2("a")).not.toBe(djb2("b"));
  });
});

describe("basketToLovableCategory", () => {
  test("wealth→finance、family→life、其余透传", () => {
    expect(basketToLovableCategory("wealth")).toBe("finance");
    expect(basketToLovableCategory("family")).toBe("life");
    expect(basketToLovableCategory("work")).toBe("work");
  });
});

describe("realCardToLovableIntent", () => {
  test("投影关键字段 + originalId + status", () => {
    const intent = realCardToLovableIntent(makeCard({ urgency: 0.9 }), "ready");
    expect(intent.originalId).toBe("card-1");
    expect(intent.tag).toBe("Urgent");
    expect(intent.status).toBe("ready");
    expect(intent.detail?.scores).toContainEqual({ label: "Urgency", value: 90 });
  });

  test("非 scheduled 卡 line2 为空、不泄漏 sources", () => {
    expect(realCardToLovableIntent(makeCard(), "normal").line2).toBe("");
  });

  test("reminder 卡(card-rem- id)→ reminder: true", () => {
    expect(realCardToLovableIntent(makeCard({ id: "card-rem-abc" }), "normal").reminder).toBe(true);
  });
});
