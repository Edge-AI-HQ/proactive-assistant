import type { IntentCard, EvaluationScore } from "@/types/intent-card";
import { useMemo } from "react";
import ConversationView from "./conversation/ConversationView";

interface CardChatProps {
  card: IntentCard;
  score?: EvaluationScore | null;
  onBack: () => void;
  /**
   * Non-empty → ConversationView auto-fires this as the user's first turn on
   * mount (the "Confirm" path, typically the card's primaryAction text). The
   * "Chat" button leaves this undefined → empty thread waits for the user.
   */
  bootstrapMessage?: string;
}

// Backend (`pinai-agents/.../chat/transport/routes/chat.py`) detects card-mode
// chats by `_CARD_THREAD_PREFIX = "card-thread-"`. Threads matching this prefix
// get the card-aware system prompt + card_context tooling. Card IDs are globally
// unique, so no per-user suffix is needed.
function stableSessionKey(cardId: string): string {
  return `card-thread-${cardId}`;
}

/**
 * Card chat — RC-5: now a thin wrapper over the unified `ConversationView`
 * (the actor-kernel conversation UI), keyed by the card-thread session. The
 * card JSON rides in as `cardContext` (injected server-side as a
 * <card_context> SystemMessage on the first turn) and the card metadata fills
 * the header. Replaces the old conversation runtime path.
 */
export default function CardChat({ card, score, onBack, bootstrapMessage }: CardChatProps) {
  const cardContext = useMemo(
    () => ({
      card_id: card.id,
      intent_key: card.intentKey,
      title: card.title,
      goalBasket: card.goalBasket,
      whyNow: card.whyNow,
      summary: card.summary,
      primaryAction: card.primaryAction,
      secondaryActions: card.secondaryActions,
      confidence: card.confidence,
      urgency: card.urgency,
      importance: card.importance,
      sources: card.sources,
      ...(score && {
        evaluatorScore: score.overall,
        evaluatorFeedback: score.feedback,
        evaluatorDimensions: score.dimensions,
      }),
    }),
    [card, score],
  );

  return (
    <ConversationView
      session={stableSessionKey(card.id)}
      cardContext={cardContext}
      bootstrap={bootstrapMessage}
      onBack={onBack}
      title={card.title}
      placeholder="Tell PIN AI what to change about this card…"
      headerSlot={
        <div className="px-4 pt-3 pb-1">
          <div className="glass-card px-3 py-2 text-[12px] text-foreground/60 leading-relaxed">
            <span className="font-semibold text-foreground/80">
              {card.goalBasket.toUpperCase()}
            </span>
            {" — "}
            {card.whyNow.length > 120 ? card.whyNow.slice(0, 120) + "..." : card.whyNow}
          </div>
        </div>
      }
    />
  );
}
