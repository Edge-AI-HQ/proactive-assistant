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
): Record<string, unknown> | null {
  if (!feedback) return null;
  return {
    kind: "chat_message_feedback",
    action: feedback === "up" ? "thumbs_up" : "thumbs_down",
    messageId,
    channel,
    metadata: {
      surface: "assistant_message_action_bar",
    },
  };
}
