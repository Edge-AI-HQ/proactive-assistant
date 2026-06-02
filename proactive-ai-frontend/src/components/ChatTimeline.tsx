import { useState } from "react";
import {
  Loader2, CheckCircle2, Circle, Sparkles,
} from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import CardDetailBody from "./CardDetailBody";
import type { IntentCard } from "@/types/intent-card";
import { proxyPost } from "@/lib/api";
import { basketMeta } from "@/lib/basket-meta";
import type { CardScore, UseCardsState } from "@/hooks/useCards";

type TimelineCard = IntentCard & {
  runId: string;
  runDate: string;
  score: CardScore | null;
};

interface ChatTimelineProps {
  // bootstrapMessage carries Confirm intent: when present, the chat
  // auto-fires it as the user's first turn so the agent starts working
  // on the card. Plain "Chat" path passes nothing → empty thread.
  onOpenChat: (card: IntentCard, bootstrapMessage?: string) => void;
  // ConstellationLayout passes this so Timeline/Tasks uses the same
  // rich drawer as NOW. Standalone legacy callers omit it and keep the
  // local CardDetailBody fallback below.
  onOpenCardDetail?: (card: IntentCard) => void;
  dismissedIds: Set<string>;
  confirmedIds: Set<string>;
  processingIds: Set<string>;
  doneIds: Set<string>;
  chattedIds: Set<string>;
  onDismissId: (id: string) => void;
  onConfirmId: (id: string) => void;
  onDoneId: (id: string) => void;
  onProcessingId: (id: string) => void;
  onChattedId: (id: string) => void;
  cards: UseCardsState;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function ChatTimeline({
  onOpenChat,
  onOpenCardDetail,
  dismissedIds,
  confirmedIds,
  processingIds,
  doneIds,
  chattedIds,
  onDismissId,
  onConfirmId,
  onDoneId,
  onProcessingId,
  onChattedId,
  cards,
}: ChatTimelineProps) {
  const [selectedCard, setSelectedCard] = useState<TimelineCard | null>(null);

  const handleDismiss = () => {
    if (!selectedCard) return;
    const cardId = selectedCard.id;
    onDismissId(cardId);
    proxyPost("/feedback", {
      kind: "dismiss",
      intentCardId: cardId,
      intentKey: selectedCard.intentKey,
      basket: selectedCard.goalBasket,
      channel: "web",
    }).catch(() => {});
    setSelectedCard(null);
  };

  const handleConfirm = () => {
    if (!selectedCard) return;
    const cardId = selectedCard.id;
    onConfirmId(cardId);
    onProcessingId(cardId);
    onChattedId(cardId);
    proxyPost("/feedback", {
      kind: "card_action",
      action: "confirm",
      intentCardId: cardId,
      intentKey: selectedCard.intentKey,
      basket: selectedCard.goalBasket,
      channel: "web",
    }).catch(() => {});
    setSelectedCard(null);
    // Send the card's primaryAction label (or fall back to title) as
    // the user's first message — that's what "Confirm" semantically
    // means. primaryAction is {label, type}; we send its label.
    const bootstrap =
      (selectedCard.primaryAction?.label || selectedCard.title || "").trim();
    onOpenChat(selectedCard, bootstrap || undefined);
  };

  const handleChat = () => {
    if (!selectedCard) return;
    onProcessingId(selectedCard.id);
    onChattedId(selectedCard.id);
    setSelectedCard(null);
    // No bootstrap — just enter the chat, let the user type.
    onOpenChat(selectedCard);
  };

  const handleSnooze = () => {
    if (!selectedCard) return;
    proxyPost("/feedback", {
      kind: "snooze",
      intentCardId: selectedCard.id,
      intentKey: selectedCard.intentKey,
      basket: selectedCard.goalBasket,
      channel: "web",
    }).catch(() => {});
    onDismissId(selectedCard.id);
    setSelectedCard(null);
  };

  const handleModify = () => {
    if (!selectedCard) return;
    proxyPost("/feedback", {
      kind: "card_action",
      action: "modify",
      intentCardId: selectedCard.id,
      intentKey: selectedCard.intentKey,
      basket: selectedCard.goalBasket,
      channel: "web",
    }).catch(() => {});
    onProcessingId(selectedCard.id);
    onChattedId(selectedCard.id);
    setSelectedCard(null);
    onOpenChat(selectedCard);
  };

  const handleDone = () => {
    if (!selectedCard) return;
    onDoneId(selectedCard.id);
    proxyPost("/feedback", {
      kind: "card_action",
      action: "complete",
      intentCardId: selectedCard.id,
      intentKey: selectedCard.intentKey,
      basket: selectedCard.goalBasket,
      channel: "web",
    }).catch(() => {});
    setSelectedCard(null);
  };

  const handleTextFeedback = (text: string) => {
    if (!selectedCard) return;
    proxyPost("/feedback", {
      kind: "text_feedback",
      intentCardId: selectedCard.id,
      intentKey: selectedCard.intentKey,
      basket: selectedCard.goalBasket,
      channel: "web",
      text,
    }).catch(() => {});
  };

  const allCards: TimelineCard[] = cards.cards.map((entry) => ({
    ...entry.card,
    runId: entry.runId,
    runDate: entry.runCompletedAt,
    score: entry.score,
  }));

  const grouped = new Map<string, TimelineCard[]>();
  for (const card of allCards) {
    const label = formatDate(card.runDate);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(card);
  }

  return (
    <div
      className="flex flex-col h-full px-4 pb-2 overflow-y-auto"
      style={{ paddingTop: "var(--constellation-header-top, 3.5rem)" }}
    >
      <h1 className="text-display text-2xl text-foreground mb-1">Tasks</h1>
      <p className="text-sm text-muted-foreground mb-6">AI is running these for you</p>

      {cards.loading && cards.cards.length === 0 && (
        <div className="flex items-center justify-center py-8 gap-2">
          <Loader2 size={16} className="animate-spin text-foreground/40" />
          <span className="text-[13px] text-foreground/40">Loading history...</span>
        </div>
      )}

      {[...grouped.entries()].map(([dateLabel, cards]) => (
        <div key={dateLabel} className="mb-5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 block">
            {dateLabel}
          </span>
          <div className="space-y-2">
            {cards.map((card) => {
              const meta = basketMeta(card.goalBasket);
              const CatIcon = meta.icon;
              const actionCount = card.secondaryActions?.length ?? 0;
              const isDismissed = dismissedIds.has(card.id);
              const isConfirmed = confirmedIds.has(card.id);
              const isProcessing = processingIds.has(card.id);
              const isDone = doneIds.has(card.id);
              const isChatted = chattedIds.has(card.id);
              const isActiveProcessing = isProcessing && !isDone && !isDismissed;
              const isResolved = isDismissed || isDone;

              const previewText = isDone
                ? "Completed"
                : isDismissed
                ? "Dismissed"
                : isActiveProcessing
                ? "Processing..."
                : isChatted
                ? "In conversation"
                : isConfirmed
                ? "Confirmed"
                : card.primaryAction
                ? `${actionCount + 1} operations · ${card.primaryAction.label}`
                : card.sources.join(" · ");

              return (
                <div
                  key={`${card.runId}-${card.id}`}
                  className="glass-card px-3.5 py-4 w-full text-left cursor-pointer active:scale-[0.98] transition-transform"
                  onClick={() => {
                    if (onOpenCardDetail) {
                      onOpenCardDetail(card);
                    } else {
                      setSelectedCard(card);
                    }
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-foreground/50 shrink-0">
                      <CatIcon size={16} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className={`text-[13px] font-medium leading-snug truncate flex-1 ${isResolved ? "text-foreground/35 line-through" : "text-foreground"}`}>
                          {card.title}
                        </p>
                        <span className="shrink-0 w-[18px] h-[18px] inline-flex items-center justify-center">
                          {isResolved ? (
                            <CheckCircle2 size={15} className="text-green-500/60" />
                          ) : isActiveProcessing || isChatted ? (
                            <Loader2 size={15} className="text-amber-500 animate-spin" />
                          ) : (
                            <Circle size={15} className="text-rose-400" fill="currentColor" />
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-1.5">
                        <p className="text-[11px] text-foreground/40 truncate flex-1">
                          {previewText}
                        </p>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {formatTime(card.runDate)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!cards.loading && allCards.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <div className="glass-card p-4 rounded-full">
            <Sparkles size={28} strokeWidth={1.5} className="text-foreground/40" />
          </div>
          <p className="text-display text-[15px] text-foreground/60">No cards yet</p>
          <p className="text-[13px] text-foreground/40 leading-relaxed max-w-[260px]">
            Generate intent cards from the NOW tab. All cards will appear here.
          </p>
        </div>
      )}

      <Drawer open={!!selectedCard} onOpenChange={(open) => { if (!open) setSelectedCard(null); }}>
        <DrawerContent
          className="max-h-[85vh] border-t-0 !bg-transparent"
          style={{
            background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.5) 0%, hsla(0, 0%, 100%, 0.7) 100%)",
            backdropFilter: "blur(40px) saturate(1.5)",
            WebkitBackdropFilter: "blur(40px) saturate(1.5)",
            border: "1px solid hsla(0, 0%, 100%, 0.4)",
            borderBottom: "none",
            borderRadius: "1.5rem 1.5rem 0 0",
          }}
          overlayClassName="!bg-foreground/5 backdrop-blur-[2px]"
        >
          <DrawerHeader className="sr-only">
            <DrawerTitle>{selectedCard?.title || "Card Detail"}</DrawerTitle>
            <DrawerDescription>Intent card detail view</DrawerDescription>
          </DrawerHeader>

          {selectedCard && (
            <CardDetailBody
              card={selectedCard}
              score={selectedCard.score}
              onChat={handleChat}
              onDismiss={handleDismiss}
              onConfirm={handleConfirm}
              onSnooze={handleSnooze}
              onModify={handleModify}
              onDone={handleDone}
              onTextFeedback={handleTextFeedback}
            />
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
