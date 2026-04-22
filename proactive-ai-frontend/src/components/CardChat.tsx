import type { IntentCard, EvaluationScore } from "@/types/intent-card";
import { useMemo } from "react";
import MainChatView from "./main-chat/MainChatView";

interface CardChatProps {
  card: IntentCard;
  score?: EvaluationScore | null;
  onBack: () => void;
}

function stableSessionKey(cardId: string): string {
  return `agent:main:proactive-ai:chat:card:${cardId}`;
}

export default function CardChat({ card, score, onBack }: CardChatProps) {
  const cardContext = useMemo(
    () => ({
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
    <MainChatView
      sessionKey={stableSessionKey(card.id)}
      title={card.title}
      subtitle="Chat about this card"
      onBack={onBack}
      cardContext={cardContext}
      // Card chats bootstrap with an agent-authored first message, so the
      // profile-prompt empty state from Main Chat isn't applicable here.
      // `null` suppresses it entirely; ThreadPrimitive shows nothing while
      // the bootstrap SSE stream is producing the first assistant turn.
      emptyState={null}
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
