/**
 * Feedback event payloads for chat interactions.
 *
 * A 👍/👎 on an assistant message posts a `chat_message_feedback` event to
 * `/feedback` (writes `pai_feedback_events`, keyed by the backend
 * pai_chat_messages id — that's why the action bar only enables thumbs once a
 * turn carries a real numeric id; a live turn adopts it via the
 * `chat:persisted` frame). Clearing the toggle yields no event.
 */
export type AssistantFeedback = "up" | "down";

export function buildAssistantMessageFeedbackBody(
  messageId: string,
  feedback: AssistantFeedback | null,
  channel: string,
  // Which UI element fired it — the per-message action bar (default) or the
  // card result bar. Same event kind either way; analytics tells them apart
  // (and can dedupe a double-rating of the final message) by this tag.
  surface: string = "assistant_message_action_bar",
): Record<string, unknown> | null {
  if (!feedback) return null;
  return {
    kind: "chat_message_feedback",
    action: feedback === "up" ? "thumbs_up" : "thumbs_down",
    messageId,
    channel,
    metadata: {
      surface,
    },
  };
}

/** Feedback `channel` for a conversation surface, derived from its session key
 *  — recorded on 👍/👎 events so reward analytics can tell which conversation
 *  type they came from. Shared by web (ConversationView) and RN. */
export function feedbackChannelForSession(sessionKey: string): string {
  if (sessionKey.startsWith("card-thread-")) return "card_execution";
  return "main_chat";
}
