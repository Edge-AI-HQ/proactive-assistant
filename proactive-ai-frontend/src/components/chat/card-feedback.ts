export interface CardThreadFeedbackBodyParams {
  sessionKey: string;
  userText: string;
  cardContext?: Record<string, unknown>;
}

const CARD_FEEDBACK_RE =
  /(卡片|这张卡|当前卡|推送|再发|少发|屏蔽|重复|没用|不需要|太频繁|not useful|irrelevant|too often|no more|stop showing|do not show|don't show|less of)/i;

const FUTURE_NEGATIVE_RE =
  /(不要|不用|别|别再|不要再|不用再|不想|少|屏蔽|停止|stop|don't|do not|no more|less)/i;

export function isLikelyCardPreferenceFeedback(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return CARD_FEEDBACK_RE.test(normalized) && FUTURE_NEGATIVE_RE.test(normalized);
}

export function buildCardThreadTextFeedbackBody(
  params: CardThreadFeedbackBodyParams,
): Record<string, unknown> | null {
  const text = params.userText.trim();
  if (!params.cardContext || !isLikelyCardPreferenceFeedback(text)) return null;
  const cardId = typeof params.cardContext.card_id === "string"
    ? params.cardContext.card_id
    : undefined;
  if (!cardId) return null;
  return {
    kind: "text_feedback",
    intentCardId: cardId,
    text,
    channel: "card_thread",
    conversationId: params.sessionKey,
    metadata: {
      surface: "card_thread_reply",
      cardContext: params.cardContext,
    },
  };
}
