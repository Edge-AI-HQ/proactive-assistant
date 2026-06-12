import { Loader2, CheckCircle2, Circle, CircleAlert, XCircle, Sparkles, Bell } from "lucide-react";
import type { IntentCard, CardScore, CardOutcome, CardRunStatus } from "@pin-ai/core";
import { sourceAppDisplay } from "@/components/card/source-app-display";
import { basketMeta } from "@/lib/basket-meta";
import { deriveCardUiStatus, isReminderCard } from "@pin-ai/core";
import { connectorSlugFromIntentKey } from "@/lib/connector-card";
import { getToolkit } from "@/lib/toolkit-icons";
import { useCardState } from "@/components/card/CardStateContext";

type TimelineCard = IntentCard & {
  runId: string;
  runDate: string;
  score: CardScore | null;
  runStatus: CardRunStatus | null;
  latestOutcome: CardOutcome | null;
};

interface CardTimelineProps {
  // bootstrapMessage carries Confirm intent: when present, the chat
  // auto-fires it as the user's first turn so the agent starts working
  // on the card. Plain "Chat" path passes nothing → empty thread.
  onOpenChat: (card: IntentCard, bootstrapMessage?: string) => void;
  // AppLayout passes this so Tasks opens card detail in the same rich
  // drawer as NOW (CardDrawer); the per-card action wiring lives there.
  onOpenCardDetail: (card: IntentCard) => void;
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

export default function CardTimeline({
  onOpenChat,
  onOpenCardDetail,
}: CardTimelineProps) {
  // cardsState + cardActions come from context (phase-2 de-prop-drilling).
  // Alias the action fields back to the old local names so the render/handlers
  // below are untouched.
  const { cardsState: cards, cardActions } = useCardState();
  const {
    dismissedIds,
    confirmedIds,
    processingIds,
    doneIds,
    chattedIds,
    markDismissed: onDismissId,
    markConfirmed: onConfirmId,
    clearConfirmed: onClearConfirmId,
    markDone: onDoneId,
    markProcessing: onProcessingId,
    clearProcessing: onClearProcessingId,
    markChatted: onChattedId,
  } = cardActions;
  const allCards: TimelineCard[] = cards.cards.map((entry) => ({
    ...entry.card,
    runId: entry.runId,
    runDate: entry.runCompletedAt,
    score: entry.score,
    runStatus: entry.runStatus,
    latestOutcome: entry.latestOutcome,
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
              // Connector-guidance card (intent_key="connect:<slug>"):
              // swap the basket icon for the toolkit icon so the row
              // reads as "this is a Gmail/Calendar/… nudge" at a glance.
              const connectorSlug = connectorSlugFromIntentKey(card.intentKey);
              const toolkit = connectorSlug ? getToolkit(connectorSlug) : null;
              // Reminder cards read as "this is a nudge" at a glance — bell
              // icon, same idiom as the connector toolkit swap above.
              const reminder = isReminderCard(card);
              const CatIcon = toolkit?.icon ?? (reminder ? Bell : meta.icon);
              const actionCount = card.secondaryActions?.length ?? 0;
              const isDismissed = dismissedIds.has(card.id);
              const isConfirmed = confirmedIds.has(card.id);
              const isProcessing = processingIds.has(card.id);
              const isDone = doneIds.has(card.id);
              const isChatted = chattedIds.has(card.id);
              const isResolved = isDismissed || isDone;
              // Execution state: server runStatus first (survives relaunch),
              // optimistic processingIds only as the send → run-row bridge.
              const runUi = isResolved
                ? "normal"
                : deriveCardUiStatus({
                    runStatus: card.runStatus,
                    latestOutcome: card.latestOutcome,
                    optimisticProcessing: isProcessing,
                    chatted: isChatted,
                  });
              const previewText = isDone
                ? "Completed"
                : isDismissed
                ? "Dismissed"
                : runUi === "processing"
                ? "Processing..."
                : runUi === "needs_input"
                ? "Waiting for your input"
                : runUi === "ready"
                ? "Ready for review"
                : runUi === "failed"
                ? "Failed"
                : isChatted
                ? "In conversation"
                : isConfirmed
                ? "Confirmed"
                : reminder
                // A reminder has no operations — show the nudge itself, not
                // "2 operations · Done".
                ? card.summary
                : card.primaryAction
                ? `${actionCount + 1} operations · ${card.primaryAction.label}`
                : card.sourceApps.map((slug) => sourceAppDisplay(slug).label).join(" · ");

              return (
                <div
                  key={`${card.runId}-${card.id}`}
                  className="glass-card px-3.5 py-4 w-full text-left cursor-pointer active:scale-[0.98] transition-transform"
                  onClick={() =>
                    runUi !== "normal" || isChatted
                      ? onOpenChat(card)
                      : onOpenCardDetail(card)
                  }
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-foreground/50 shrink-0">
                      <CatIcon size={16} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className={`text-[13px] font-medium leading-snug line-clamp-2 flex-1 ${isResolved ? "text-foreground/35 line-through" : "text-foreground"}`}>
                          {card.title}
                        </p>
                        <span className="shrink-0 w-[18px] h-[18px] inline-flex items-center justify-center">
                          {isResolved ? (
                            <CheckCircle2 size={15} className="text-green-500/60" />
                          ) : runUi === "processing" ? (
                            <Loader2 size={15} className="text-amber-500 animate-spin" />
                          ) : runUi === "needs_input" ? (
                            <CircleAlert size={15} className="text-amber-500 animate-pulse" />
                          ) : runUi === "ready" ? (
                            <CheckCircle2 size={15} className="text-green-500" />
                          ) : runUi === "failed" ? (
                            <XCircle size={15} className="text-rose-500" />
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
    </div>
  );
}
