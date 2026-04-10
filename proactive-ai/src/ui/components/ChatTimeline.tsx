import { useState, useEffect } from "react";
import {
  Sprout, Briefcase, TrendingUp, Heart, Sparkles, Users,
  Loader2, CheckCircle2, Zap, Pencil, MessageCircle,
  type LucideIcon,
} from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import type { IntentCard, EvaluationScore } from "@/hooks/use-pipeline";
import { apiFetch } from "@/lib/api";

const BASKET_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  work:    { icon: Briefcase,   label: "Work" },
  health:  { icon: Heart,       label: "Health" },
  family:  { icon: Users,       label: "Family" },
  wealth:  { icon: TrendingUp,  label: "Finance" },
  finance: { icon: TrendingUp,  label: "Finance" },
  growth:  { icon: Sprout,      label: "Growth" },
  life:    { icon: Sparkles,    label: "Life" },
};

const FALLBACK = { icon: Sparkles, label: "General" };
function basketMeta(key: string) {
  return BASKET_ICONS[key?.toLowerCase()] ?? FALLBACK;
}

interface StoredRun {
  id: string;
  completedAt: string;
  totalIterations: number;
  finalCards: IntentCard[];
  scoreMap?: Record<string, EvaluationScore>;
}

type TimelineCard = IntentCard & {
  runId: string;
  runDate: string;
  score: EvaluationScore | null;
};

interface ChatTimelineProps {
  onOpenChat?: (card: IntentCard) => void;
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

function CardDetailDrawerBody({
  card,
  onOpenChat,
}: {
  card: TimelineCard;
  onOpenChat?: (card: IntentCard) => void;
}) {
  const meta = basketMeta(card.goalBasket);
  const Icon = meta.icon;
  const evalScore = card.score;

  const scores: { label: string; value: number; highlight?: boolean }[] = [
    { label: "Confidence", value: Math.round(card.confidence * 100) },
    { label: "Importance", value: Math.round(card.importance * 100) },
    { label: "Urgency", value: Math.round(card.urgency * 100) },
  ];
  if (evalScore) {
    scores.push({ label: "Overall", value: Math.round(evalScore.overall * 10), highlight: true });
  }

  return (
    <div className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]">
      {/* Category + Title */}
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} strokeWidth={1.5} className="text-foreground/50" />
        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">
          {meta.label}
        </span>
        {card.urgency >= 0.85 && (
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
            Urgent
          </span>
        )}
      </div>
      <h3 className="text-display text-lg text-foreground mb-2">{card.title}</h3>

      {/* Scores grid */}
      <div className={`grid gap-2 mb-4 ${scores.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
        {scores.map((s) => (
          <div key={s.label} className="rounded-xl bg-foreground/5 py-2.5 text-center">
            <div className={`text-base font-bold ${s.highlight ? "text-purple-600" : "text-foreground/80"}`}>
              {s.value}
            </div>
            <div className="text-[11px] text-foreground/45 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* WhyNow / Summary */}
      {card.whyNow && (
        <div className="rounded-xl bg-green-50/60 border border-green-200/40 p-3 mb-4">
          <div className="text-xs font-semibold text-green-700/80 mb-1">Why Now</div>
          <p className="text-[13px] text-foreground/80 leading-relaxed">{card.whyNow}</p>
        </div>
      )}

      {card.summary && (
        <div className="rounded-xl bg-foreground/[0.03] border border-foreground/10 p-3 mb-4">
          <div className="text-xs font-semibold text-foreground/50 mb-1">Summary</div>
          <p className="text-[13px] text-foreground/70 leading-relaxed">{card.summary}</p>
        </div>
      )}

      {/* Sources */}
      {card.sources.length > 0 && (
        <div className="mb-4">
          <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-2">Sources</div>
          {card.sources.map((src, i) => (
            <div key={i} className="flex items-start gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-foreground/30 mt-1.5 shrink-0" />
              <span className="text-[13px] text-foreground/60">{src}</span>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      {(card.primaryAction || card.secondaryActions.length > 0) && (
        <div className="mb-4">
          <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-2">Available Actions</div>
          <div className="flex flex-col gap-1.5">
            {card.primaryAction && (
              <div className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2">
                <Zap size={12} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
                <span className="text-[13px] text-foreground/70 flex-1">{card.primaryAction.label}</span>
                <span className="text-[11px] text-foreground/35 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">
                  {card.primaryAction.type}
                </span>
              </div>
            )}
            {card.secondaryActions.map((action, i) => (
              <div key={i} className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2">
                <Pencil size={12} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
                <span className="text-[13px] text-foreground/70 flex-1">{action.label}</span>
                <span className="text-[11px] text-foreground/35 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">
                  {action.type}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Evaluator feedback */}
      {evalScore?.feedback && (
        <div className="mb-4">
          <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-2">Evaluator Feedback</div>
          <p className="text-[13px] text-foreground/60 leading-relaxed">{evalScore.feedback}</p>
        </div>
      )}

      {/* Chat button */}
      <button
        onClick={() => onOpenChat?.(card)}
        className="w-full py-3 rounded-2xl bg-foreground text-background text-sm font-semibold hover:bg-foreground/85 transition-colors flex items-center justify-center gap-2"
      >
        <MessageCircle size={16} strokeWidth={1.8} />
        Chat about this card
      </button>
    </div>
  );
}

export default function ChatTimeline({ onOpenChat }: ChatTimelineProps) {
  const [historicalRuns, setHistoricalRuns] = useState<StoredRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [selectedCard, setSelectedCard] = useState<TimelineCard | null>(null);

  useEffect(() => {
    async function fetchRuns() {
      try {
        const res = await apiFetch("/api/runs");
        const data = await res.json();
        if (data.ok) setHistoricalRuns(data.runs ?? []);
      } catch { /* ignore */ }
      finally { setLoadingRuns(false); }
    }
    fetchRuns();
    const interval = window.setInterval(fetchRuns, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const allCards: TimelineCard[] = historicalRuns.flatMap((run) =>
    (run.finalCards ?? []).map((card) => ({
      ...card,
      runId: run.id,
      runDate: run.completedAt,
      score: run.scoreMap?.[card.id] ?? null,
    }))
  );

  const grouped = new Map<string, TimelineCard[]>();
  for (const card of allCards) {
    const label = formatDate(card.runDate);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(card);
  }

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <h1 className="text-display text-2xl text-foreground mb-1 pr-20">Timeline</h1>
      <p className="text-sm text-muted-foreground mb-6">AI memory &amp; action log</p>

      {loadingRuns && (
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
              const previewText = card.primaryAction
                ? `${actionCount + 1} operations · ${card.primaryAction.label}`
                : card.sources.join(" · ");

              return (
                <div
                  key={`${card.runId}-${card.id}`}
                  className="glass-card px-3.5 py-3 w-full text-left cursor-pointer active:scale-[0.98] transition-transform"
                  onClick={() => setSelectedCard(card)}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-foreground/50 shrink-0">
                      <CatIcon size={14} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-[13px] font-medium text-foreground leading-tight truncate flex-1">
                          {card.title}
                        </p>
                        <span className="shrink-0 w-[16px] h-[16px] inline-flex items-center justify-center">
                          <CheckCircle2 size={14} className="text-green-500/60" />
                        </span>
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <p className="text-[11px] text-foreground/35 truncate flex-1">
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

      {!loadingRuns && allCards.length === 0 && (
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

      {/* Card Detail Drawer */}
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
            <CardDetailDrawerBody
              card={selectedCard}
              onOpenChat={(card) => {
                setSelectedCard(null);
                onOpenChat?.(card);
              }}
            />
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
