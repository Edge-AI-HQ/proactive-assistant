import { describe, expect, test } from "vitest";

import { buildAssistantMessageFeedbackBody } from "./chat-feedback";

describe("assistant message feedback payload", () => {
  test("builds a thumbs-up event tagged with the conversation channel", () => {
    expect(buildAssistantMessageFeedbackBody("msg_assistant_1", "up", "main_chat")).toEqual({
      kind: "chat_message_feedback",
      action: "thumbs_up",
      messageId: "msg_assistant_1",
      channel: "main_chat",
      metadata: {
        surface: "assistant_message_action_bar",
      },
    });
  });

  test("passes the channel through (card / proactive surfaces, not just main)", () => {
    expect(buildAssistantMessageFeedbackBody("msg_assistant_2", "down", "card_execution")).toEqual({
      kind: "chat_message_feedback",
      action: "thumbs_down",
      messageId: "msg_assistant_2",
      channel: "card_execution",
      metadata: {
        surface: "assistant_message_action_bar",
      },
    });
  });

  test("does not write a feedback event when the user clears the local toggle", () => {
    expect(buildAssistantMessageFeedbackBody("msg_assistant_3", null, "proactive")).toBeNull();
  });
});
