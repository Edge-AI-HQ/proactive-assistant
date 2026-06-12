// /feedback payload 是协议契约（kind/intentCardId/basket/channel）——锁形状。
import { describe, expect, test } from "vitest";

import {
  cardActionFeedbackBody,
  confirmBootstrap,
  dismissFeedbackBody,
  snoozeFeedbackBody,
  steerBootstrap,
  textFeedbackBody,
} from "./card-actions";
import type { IntentCard } from "./intent-card";

const card: IntentCard = {
  id: "card_1",
  intentKey: "work:reply-email",
  goalBasket: "work",
  title: "Reply to the OpenAI ticket",
  whyNow: "waiting",
  summary: "waiting",
  primaryAction: { label: "Draft a reply", type: "confirm", agentPrompt: "Draft and send the reply" },
  secondaryActions: [],
  confidence: 0.8,
  urgency: 0.5,
  importance: 0.7,
  sources: [],
  sourceApps: [],
  reasoningSteps: [],
  agentChain: [],
  createdAt: "",
};

describe("feedback payload contracts", () => {
  test("card_action body shape", () => {
    expect(cardActionFeedbackBody("confirm", card)).toEqual({
      kind: "card_action",
      action: "confirm",
      intentCardId: "card_1",
      intentKey: "work:reply-email",
      basket: "work",
      channel: "web",
    });
  });

  test("dismiss / snooze / text_feedback bodies", () => {
    expect(dismissFeedbackBody(card)).toMatchObject({ kind: "dismiss", intentCardId: "card_1" });
    expect(snoozeFeedbackBody(card)).toMatchObject({ kind: "snooze", channel: "web" });
    expect(textFeedbackBody(card, "less of this")).toMatchObject({
      kind: "text_feedback",
      text: "less of this",
    });
  });
});

describe("chat bootstraps", () => {
  test("confirm prefers agentPrompt over label/title", () => {
    expect(confirmBootstrap(card)).toBe("Draft and send the reply");
    expect(
      confirmBootstrap({ ...card, primaryAction: { label: "Do it", type: "confirm" } }),
    ).toBe("Do it");
  });

  test("steer bootstrap embeds the original plan and ask-first semantics", () => {
    const text = steerBootstrap(card);
    expect(text).toContain("Original plan: Draft a reply");
    expect(text).toContain("wait for my reply before executing");
  });
});
