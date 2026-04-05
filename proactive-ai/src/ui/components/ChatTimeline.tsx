import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Sprout, Briefcase, TrendingUp, Heart, Sparkles, Users,
  Loader2, Check, MessageCircle,
  type LucideIcon,
} from "lucide-react";
import type { IntentCard, EvaluationScore } from "@/hooks/use-pipeline";
import { apiFetch } from "@/lib/api";

const BASKET_ICONS: Record<string, LucideIcon> = {
  work: Briefcase,
  health: Heart,
  family: Users,
  wealth: TrendingUp,
  finance: TrendingUp,
  growth: Sprout,
  life: Sparkles,
};

interface StoredRun {
  id: string;
  completedAt: string;
  totalIterations: number;
  finalCards: IntentCard[];
  scoreMap?: Record<string, EvaluationScore>;
}

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

export default function ChatTimeline({ onOpenChat }: ChatTimelineProps) {
  const [historicalRuns, setHistoricalRuns] = useState<StoredRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

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

  const allCards = historicalRuns.flatMap((run) =>
    (run.finalCards ?? []).map((card) => ({
      ...card,
      runId: run.id,
      runDate: run.completedAt,
      runIterations: run.totalIterations,
      score: run.scoreMap?.[card.id] ?? null,
    }))
  );

  const grouped = new Map<string, typeof allCards>();
  for (const card of allCards) {
    const label = formatDate(card.runDate);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(card);
  }

  return (
    <div className="flex flex-col h-full px-4 pt-14 pb-2 overflow-y-auto">
      <h1 className="text-display text-2xl text-foreground mb-1">Timeline</h1>
      <p className="text-sm text-muted-foreground mb-6">All generated intent cards</p>

      {/* Loading state */}
      {loadingRuns && (
        <div className="flex items-center justify-center py-8 gap-2">
          <Loader2 size={16} className="animate-spin text-foreground/40" />
          <span className="text-[13px] text-foreground/40">Loading history...</span>
        </div>
      )}

      {/* Historical cards grouped by date */}
      {[...grouped.entries()].map(([dateLabel, cards]) => (
        <div key={dateLabel} className="mb-5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 block">
            {dateLabel}
          </span>
          <div className="space-y-3">
            {cards.map((card, i) => {
              const Icon = BASKET_ICONS[card.goalBasket?.toLowerCase()] ?? Sparkles;
              return (
                <motion.div
                  key={`${card.runId}-${card.id}`}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="glass-card p-4"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-foreground/60 mt-0.5">
                      <Icon size={16} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold uppercase text-foreground/50 tracking-wide">
                          {card.goalBasket}
                        </span>
                        {card.score ? (
                          <span className={`ml-auto inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${
                            card.score.overall >= 8
                              ? "text-emerald-600 bg-emerald-500/10"
                              : card.score.overall >= 5
                                ? "text-amber-600 bg-amber-500/10"
                                : "text-red-500 bg-red-500/10"
                          }`}>
                            Score {card.score.overall.toFixed(1)}
                          </span>
                        ) : (
                          <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                            <Check size={10} />
                            Ready
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-medium text-foreground leading-snug">
                        {card.title}
                      </p>
                      <p className="text-[12px] text-foreground/50 mt-1 line-clamp-2">
                        {card.whyNow}
                      </p>
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {(card.sources ?? []).map((s: string) => (
                          <span
                            key={s}
                            className="text-[10px] px-2 py-0.5 rounded-full bg-foreground/5 text-foreground/40 font-medium"
                          >
                            {s}
                          </span>
                        ))}
                        <span className="text-[10px] text-muted-foreground ml-auto">
                          {formatTime(card.runDate)}
                        </span>
                      </div>

                      {/* Score badges */}
                      {card.score && (
                        <div className="flex items-center gap-2 mt-2">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            card.score.overall >= 8
                              ? "bg-emerald-500/15 text-emerald-600"
                              : card.score.overall >= 5
                                ? "bg-amber-500/15 text-amber-600"
                                : "bg-red-500/15 text-red-500"
                          }`}>
                            {card.score.overall.toFixed(1)}
                          </span>
                          {card.score.dimensions && (
                            <span className="text-[9px] text-foreground/30">
                              R{card.score.dimensions.relevance.toFixed(0)} ·
                              A{card.score.dimensions.actionability.toFixed(0)} ·
                              W{card.score.dimensions.whyNowClarity.toFixed(0)} ·
                              N{card.score.dimensions.novelty.toFixed(0)} ·
                              D{card.score.dimensions.decisionCompression.toFixed(0)}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Chat button */}
                      <button
                        onClick={() => onOpenChat?.(card)}
                        className="mt-2.5 flex items-center gap-1.5 text-[12px] font-medium text-foreground/45 hover:text-foreground/70 transition-colors"
                      >
                        <MessageCircle size={13} strokeWidth={1.5} />
                        Chat about this
                      </button>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Empty state */}
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
    </div>
  );
}
