import type { IntentCard, EvaluationScore } from "@/types/intent-card";
import { useMemo } from "react";
import MainChatView from "./main-chat/MainChatView";
import { useProactiveChatRuntime } from "./chat/useProactiveChatRuntime";

interface CardChatProps {
  card: IntentCard;
  score?: EvaluationScore | null;
  onBack: () => void;
  /**
   * Non-empty → adapter auto-fires this as the user's first turn on
   * mount. Set by the "Confirm" button path (typically the card's
   * primaryAction text). The "Chat" button leaves this undefined →
   * empty thread waits for user to type. Empty bootstrap is rejected
   * by the backend's strict ChatSendRequest schema, so the FE simply
   * never auto-fires when the field is absent.
   */
  bootstrapMessage?: string;
}

// Backend (`pinai-agents/.../chat/routes/chat.py`) detects card-mode chats by
// `_CARD_THREAD_PREFIX = "card-thread-"`. Threads matching this prefix get the
// card-aware system prompt + card_context tooling; anything else falls through
// to main-chat. Card IDs are globally unique, so no per-user suffix is needed.
function stableSessionKey(cardId: string): string {
  return `card-thread-${cardId}`;
}

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

  const sessionKey = stableSessionKey(card.id);
  const { runtime, historyLoaded } = useProactiveChatRuntime({
    sessionKey,
    cardContext,
    bootstrapMessage,
  });

  return (
    <MainChatView
      sessionKey={sessionKey}
      runtime={runtime}
      historyLoaded={historyLoaded}
      title={card.title}
      subtitle="Chat about this card"
      onBack={onBack}
      // Card chats bootstrap with an agent-authored first message, so the
      // profile-prompt empty state from Main Chat isn't applicable here.
      // `null` suppresses it entirely; ThreadPrimitive shows nothing while
      // the bootstrap SSE stream is producing the first assistant turn.
      emptyState={null}
      renderProposeActionAsText
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
