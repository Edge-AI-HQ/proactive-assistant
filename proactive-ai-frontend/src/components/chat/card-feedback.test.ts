import { describe, expect, test } from "vitest";

import {
  buildCardThreadTextFeedbackBody,
  isLikelyCardPreferenceFeedback,
} from "./card-feedback";

const cardContext = {
  card_id: "card-1",
  intent_key: "work:charging-check",
  goalBasket: "work",
  title: "检查充电桩",
};

describe("card thread feedback detection", () => {
  test("detects future card preference feedback", () => {
    expect(isLikelyCardPreferenceFeedback("不用再发这个什么检查充电桩的卡片了")).toBe(true);
    expect(isLikelyCardPreferenceFeedback("Stop showing this card again")).toBe(true);
  });

  test("does not treat ordinary execution instructions as card feedback", () => {
    expect(isLikelyCardPreferenceFeedback("19:30 出发，不充电")).toBe(false);
    expect(isLikelyCardPreferenceFeedback("不要发送邮件，先保存草稿")).toBe(false);
  });

  test("builds a text_feedback payload for card-thread preference feedback", () => {
    expect(
      buildCardThreadTextFeedbackBody({
        sessionKey: "card-thread-card-1",
        userText: "不用再发这个什么检查充电桩的卡片了",
        cardContext,
      }),
    ).toEqual({
      kind: "text_feedback",
      intentCardId: "card-1",
      intentKey: "work:charging-check",
      basket: "work",
      text: "不用再发这个什么检查充电桩的卡片了",
      channel: "card_thread",
      conversationId: "card-thread-card-1",
      metadata: {
        surface: "card_thread_reply",
        cardContext,
      },
    });
  });
});
