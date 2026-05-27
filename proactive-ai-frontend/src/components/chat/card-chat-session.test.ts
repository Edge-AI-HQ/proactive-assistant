import { describe, expect, test } from "vitest";

import {
  buildChatRequestBody,
  buildRequestUserText,
  stripRequestOnlyCardContext,
  shouldIncludeCardContext,
} from "./card-chat-session";

const cardContext = {
  card_id: "card-1",
  title: "Card one",
};

describe("card chat session request helpers", () => {
  test("includes card context for an existing main chat turn", () => {
    expect(
      shouldIncludeCardContext({
        hasCardContext: true,
        isFreshThread: false,
        sessionKey: "main-42-existing",
      }),
    ).toBe(true);
  });

  test("keeps card-thread context one-shot on the first turn", () => {
    expect(
      shouldIncludeCardContext({
        hasCardContext: true,
        isFreshThread: false,
        sessionKey: "card-thread-card-1",
      }),
    ).toBe(false);
  });

  test("builds a request body with cardContext when requested", () => {
    expect(
      buildChatRequestBody({
        sessionKey: "main-42-existing",
        userText: "This card is not useful",
        cardContext,
        includeCardContext: true,
      }),
    ).toEqual({
      sessionKey: "main-42-existing",
      message: "This card is not useful",
      cardContext,
    });
  });

  test("inlines card context for feedback turns in the request text", () => {
    const text = buildRequestUserText({
      sessionKey: "main-user-thread",
      userText: "当前卡片是什么",
      cardContext,
    });

    expect(text).toContain("<current_feedback_card>");
    expect(text).toContain("card-1");
    expect(text).toContain("Card one");
    expect(text).toContain("User message:\n当前卡片是什么");
  });

  test("inlines card context for card-thread feedback turns", () => {
    const text = buildRequestUserText({
      sessionKey: "card-thread-card_123",
      userText: "当前卡片是什么",
      cardContext,
    });

    expect(text).toContain("<current_feedback_card>");
    expect(text).toContain("card-1");
    expect(text).toContain("User message:\n当前卡片是什么");
  });

  test("strips request-only card context from history text", () => {
    const text = buildRequestUserText({
      sessionKey: "main-user-thread",
      userText: "这张卡片明天不要再出现",
      cardContext,
    });

    expect(stripRequestOnlyCardContext(text)).toBe("这张卡片明天不要再出现");
  });
});
