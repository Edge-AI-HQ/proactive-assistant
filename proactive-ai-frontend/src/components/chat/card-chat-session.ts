/** Legacy chat-stream sends wrapped the card payload INTO the user message
 *  text (`<current_feedback_card>…`). The conversation pipeline carries the
 *  card as a `cardContext` field instead, but rows persisted by the old path
 *  still hold the wrapper — strip it when rendering history. */
const CARD_FEEDBACK_CONTEXT_RE =
  /^<current_feedback_card>[\s\S]*?<\/current_feedback_card>\s*\n+User message:\n/;

export function stripRequestOnlyCardContext(text: string): string {
  return text.replace(CARD_FEEDBACK_CONTEXT_RE, "");
}
