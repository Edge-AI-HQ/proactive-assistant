import { useMemo } from "react";
import type { IntentCard } from "@pin-ai/core";
import {
  buildCardContext,
  CardContextHeaderSlot,
  cardThreadSessionKey,
  ConversationView,
  realIntentToChatCard,
} from "@pin-ai/ui-web";

/**
 * zebra card chat 面板体 —— production ChatDetailView 的桌面装配（同一条
 * 真实链路：card-thread session + <card_context> + ConversationView frames
 * SSE + 顶部 context chip）。桌面差异：无 vaul bottom-drawer——context chip
 * 点击经 onOpenDetail 切到 zebra detail 面板。slide-over 与 TASKS 右 pane
 * 复用同一组件。
 */
export default function ZebraCardChat({
  card,
  bootstrap,
  onBack,
  onOpenDetail,
  onDone,
  onComment,
  onTurnDone,
}: {
  card: IntentCard;
  bootstrap?: string;
  onBack: () => void;
  onOpenDetail?: () => void;
  onDone: () => boolean | void | Promise<boolean | void>;
  onComment: (text: string) => void | Promise<void>;
  onTurnDone?: () => void;
}) {
  const chatCard = useMemo(() => realIntentToChatCard(card), [card]);
  const sessionKey = useMemo(
    () => cardThreadSessionKey(chatCard, card.id),
    [chatCard, card.id],
  );
  const cardContext = useMemo(() => buildCardContext(chatCard), [chatCard]);

  return (
    <ConversationView
      session={sessionKey}
      cardContext={cardContext}
      bootstrap={bootstrap}
      title={card.title}
      onBack={onBack}
      backIcon="down"
      onTurnDone={onTurnDone}
      cardFeedback={{ onDone, onComment }}
      placeholder="Message about this card..."
      headerSlot={
        <CardContextHeaderSlot
          card={chatCard}
          onOpen={onOpenDetail ?? (() => {})}
        />
      }
    />
  );
}
