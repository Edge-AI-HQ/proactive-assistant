import { describe, expect, test } from "vitest";

import { buildAssistantMessageFeedbackBody } from "./MessageActionBar";

describe("assistant message feedback payload", () => {
  test("builds unified feedback event for thumbs up", () => {
    expect(buildAssistantMessageFeedbackBody("msg_assistant_1", "up")).toEqual({
      kind: "chat_message_feedback",
      action: "thumbs_up",
      messageId: "msg_assistant_1",
      channel: "main_chat",
      metadata: {
        surface: "assistant_message_action_bar",
      },
    });
  });

  test("builds unified feedback event for thumbs down", () => {
    expect(buildAssistantMessageFeedbackBody("msg_assistant_2", "down")).toEqual({
      kind: "chat_message_feedback",
      action: "thumbs_down",
      messageId: "msg_assistant_2",
      channel: "main_chat",
      metadata: {
        surface: "assistant_message_action_bar",
      },
    });
  });

  test("does not write a feedback event when the user clears the local toggle", () => {
    expect(buildAssistantMessageFeedbackBody("msg_assistant_3", null)).toBeNull();
  });
});
