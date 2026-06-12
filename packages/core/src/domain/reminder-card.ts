/**
 * Reminder-card detection — the acknowledge-only card class.
 *
 * Reminder cards ("drink water", "take meds") come from the zero-LLM
 * reminder subsystem (pinai-agents web/services/reminder_cards.py), not the
 * generator. They carry `cardKind: "reminder"` stamped at creation; cards
 * persisted BEFORE that field existed are recognized by their `card-rem-`
 * id prefix (history JSONB is never backfilled).
 *
 * Mirrors proactive-ai-frontend lib/connector-card.ts (`connect:` intentKey
 * prefix) but lives in core domain — it is dependency-free and the surfaces
 * branch on it — drawer shows Dismiss/Chat/Done instead
 * of the execute (Approve) flow, timeline swaps in a bell icon.
 */

import type { IntentCard } from "./intent-card";

export const REMINDER_CARD_KIND = "reminder";

const REMINDER_ID_PREFIX = "card-rem-";

export function isReminderCard(card: Pick<IntentCard, "id" | "cardKind">): boolean {
  return (
    card.cardKind === REMINDER_CARD_KIND || card.id.startsWith(REMINDER_ID_PREFIX)
  );
}
