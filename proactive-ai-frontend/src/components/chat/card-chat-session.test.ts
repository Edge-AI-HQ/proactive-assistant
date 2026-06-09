import { describe, expect, test } from "vitest";

import { stripRequestOnlyCardContext } from "./card-chat-session";

// Mirrors the exact wrapper the legacy chat-stream path persisted into user
// rows. The builder is gone (conversation sends cardContext as a field), but
// old rows live in pai_chat_messages forever — strip must keep working.
const legacyWrapped = [
  "<current_feedback_card>",
  "The user is giving feedback on this exact current card. Use this card when they say this card / 这张卡 / 当前卡片.",
  JSON.stringify({ card_id: "card-1", title: "Card one" }, null, 2),
  "</current_feedback_card>",
  "",
  "User message:",
  "这张卡片明天不要再出现",
].join("\n");

describe("stripRequestOnlyCardContext", () => {
  test("strips the legacy request-only card context wrapper", () => {
    expect(stripRequestOnlyCardContext(legacyWrapped)).toBe("这张卡片明天不要再出现");
  });

  test("leaves unwrapped text untouched", () => {
    expect(stripRequestOnlyCardContext("plain reply")).toBe("plain reply");
  });
});
