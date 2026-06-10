import { useRef } from "react";
import ChatSheetOverlay from "@/components/chat/ChatSheetOverlay";
import ChatDetailView from "@/components/chat/ChatDetailView";
import { realIntentToChatCard } from "@/components/now/card-model";
import type { IntentCard } from "@/types/intent-card";

export interface CardChatTarget {
  card: IntentCard;
  /** Confirm-path primaryAction text; the chat runtime auto-fires it only
   *  when the thread is empty. */
  bootstrap?: string;
}

interface CardChatOverlayProps {
  /** Non-null mounts the sheet for that card. */
  target: CardChatTarget | null;
  /** Called once the sheet has finished sinking — clears `target`. */
  onBack: () => void;
  /** Sphere → TASKS lifecycle: Dismiss / Done in the chat toolbar must POST
   *  /feedback so the card moves off the sphere (dismissedIds / doneIds
   *  filter) and shows as Dismissed / Completed in the TASKS view. Without
   *  these the hook's cancel/confirmDone are purely local UI flips. */
  onDismissBackend: (card: IntentCard) => void | Promise<void>;
  onDoneBackend: (card: IntentCard) => boolean | void | Promise<boolean | void>;
}

/**
 * Card chat overlay — the same full-screen sheet idiom as MainChatOverlay
 * (shared ChatSheetOverlay: portal, bottom-sheet entry, left-edge swipe →
 * downward sink revealing the live layout beneath). Replaces the old
 * ViewRouter branch that slid the card chat out HORIZONTALLY via
 * SwipeBackLayer — the two chats now dismiss identically.
 */
export default function CardChatOverlay({
  target,
  onBack,
  onDismissBackend,
  onDoneBackend,
}: CardChatOverlayProps) {
  // Latch the last non-null target: `target` is cleared when the sheet has
  // already sunk off-screen, but the exit fade still renders one last frame —
  // without the latch the card content would blank out mid-exit.
  const lastTarget = useRef<CardChatTarget | null>(null);
  if (target) lastTarget.current = target;
  const shown = target ?? lastTarget.current;

  return (
    <ChatSheetOverlay open={target !== null} onClosed={onBack}>
      {(dismiss) =>
        shown ? (
          <ChatDetailView
            card={realIntentToChatCard(shown.card)}
            runId={shown.card.id}
            bootstrap={shown.bootstrap}
            onBack={dismiss}
            onDismissBackend={() => onDismissBackend(shown.card)}
            onDoneBackend={() => onDoneBackend(shown.card)}
          />
        ) : null
      }
    </ChatSheetOverlay>
  );
}
