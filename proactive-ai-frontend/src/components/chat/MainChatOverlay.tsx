import ChatSheetOverlay from "@/components/chat/ChatSheetOverlay";
import MainChat from "@/components/chat/MainChat";

interface MainChatOverlayProps {
  /** Opens the overlay. Toggled by the bottom-center ASK PIN AI button. */
  open: boolean;
  /** Closes the overlay (swipe-dismiss commit or the chat's own back button). */
  onBack: () => void;
}

/**
 * Main chat overlay. Opened by the bottom-center ASK PIN AI button.
 * Separate from card chat: a standalone main thread per user. The sheet
 * behaviour (portal, bottom-sheet entry, left-edge swipe → downward sink)
 * lives in the shared ChatSheetOverlay, which CardChatOverlay uses too, so
 * both chats enter and leave identically.
 */
export default function MainChatOverlay({ open, onBack }: MainChatOverlayProps) {
  return (
    <ChatSheetOverlay open={open} onClosed={onBack}>
      {(dismiss) => <MainChat onBack={dismiss} />}
    </ChatSheetOverlay>
  );
}
