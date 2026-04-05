import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sprout, Briefcase, TrendingUp, Heart, Sparkles, Users,
  Zap, Pencil, X, ChevronDown, MessageCircle, Check,
  type LucideIcon,
} from "lucide-react";
import type { IntentCard, EvaluationScore } from "../hooks/use-pipeline";
import AiLanding from "./AiLanding";

const BASKET_META: Record<string, { icon: LucideIcon; label: string }> = {
  work:    { icon: Briefcase,   label: "Work" },
  health:  { icon: Heart,       label: "Health" },
  family:  { icon: Users,       label: "Family" },
  wealth:  { icon: TrendingUp,  label: "Finance" },
  finance: { icon: TrendingUp,  label: "Finance" },
  growth:  { icon: Sprout,      label: "Growth" },
  life:    { icon: Sparkles,    label: "Life" },
};

const FALLBACK_META = { icon: Sparkles, label: "General" };

function basketMeta(goalBasket: IntentCard["goalBasket"]) {
  return BASKET_META[goalBasket.toLowerCase()] ?? FALLBACK_META;
}

import { apiPost } from "@/lib/api";

async function recordFeedback(params: {
  kind: string;
  action?: string;
  intentCardId: string;
  basket?: string;
}) {
  try {
    await apiPost("/api/feedback", params);
  } catch { /* best-effort, don't block UI */ }
}

interface NowFeedProps {
  cards: IntentCard[];
  scoreMap: Record<string, EvaluationScore>;
  isRunning: boolean;
  activePhase: string | null;
  onExecute: (title: string) => void;
  onScrollDirectionChange?: (direction: "up" | "down") => void;
  onOpenChat?: (cardId: string) => void;
  onGenerate?: () => void;
  onTapToSpeak?: () => void;
}

export default function NowFeed({
  cards: incomingCards,
  scoreMap,
  isRunning,
  activePhase,
  onExecute,
  onScrollDirectionChange,
  onOpenChat,
  onGenerate,
  onTapToSpeak,
}: NowFeedProps) {
  const INITIAL_VISIBLE = 5;
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [feedbackCardId, setFeedbackCardId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollY, setScrollY] = useState(0);
  const lastScrollTop = useRef(0);

  useEffect(() => { setVisibleCount(INITIAL_VISIBLE); }, [incomingCards]);

  const allCards = incomingCards.filter((c) => !dismissedIds.has(c.id));
  const cards = allCards.slice(0, visibleCount);
  const hasMore = allCards.length > visibleCount;

  const handleScroll = useCallback(() => {
    if (scrollRef.current) {
      const top = scrollRef.current.scrollTop;
      setScrollY(top);
      const delta = top - lastScrollTop.current;
      if (Math.abs(delta) > 3) {
        onScrollDirectionChange?.(delta > 0 ? "up" : "down");
      }
      lastScrollTop.current = top;
    }
  }, [onScrollDirectionChange]);

  const dismiss = (id: string, basket: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissedIds((prev) => new Set(prev).add(id));
    recordFeedback({ kind: "dismiss", intentCardId: id, basket });
  };

  const toggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const landingOpacity = Math.max(0.2, 1 - scrollY / 600);

  const showLoadingOverlay = isRunning && allCards.length === 0;
  const showEmptyPrompt = !isRunning && allCards.length === 0;

  return (
    <div className="relative h-full overflow-hidden">
      {/* Fixed Landing behind */}
      <div
        className="absolute inset-x-0 top-0 z-0"
        style={{ opacity: landingOpacity, willChange: "opacity" }}
      >
        <AiLanding onTapToSpeak={onTapToSpeak} />

        {showLoadingOverlay && (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass-card-strong px-6 py-4 text-center"
            >
              <div className="flex items-center gap-2 justify-center mb-1">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                >
                  <Sparkles size={16} className="text-foreground/60" />
                </motion.div>
                <span className="text-sm font-medium text-foreground/80">
                  {activePhase === "generating"
                    ? "Generating your intent cards..."
                    : activePhase === "evaluating"
                      ? "Evaluating cards..."
                      : activePhase === "planning"
                        ? "Planning your intents..."
                        : "Generating your intent cards..."}
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </div>

      {/* Scrollable sheet that slides over landing */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative z-10 h-full overflow-y-auto"
        style={{ scrollBehavior: "smooth" }}
      >
        {/* Spacer to show landing initially */}
        <div className="pointer-events-none" style={{ height: "60vh" }} />

        {/* Cards sheet */}
        <div
          className="relative px-4 pb-4"
          style={{
            borderRadius: "1.5rem 1.5rem 0 0",
            background: "linear-gradient(180deg, hsl(0 0% 100% / 0.15) 0%, hsl(0 0% 100% / 0.35) 120px, hsl(0 0% 100% / 0.5) 100%)",
            backdropFilter: "blur(40px)",
            WebkitBackdropFilter: "blur(40px)",
            minHeight: "80vh",
          }}
        >
          {/* Pull indicator */}
          <div className="flex justify-center pt-3 pb-4">
            <div className="w-9 h-1 rounded-full bg-foreground/15" />
          </div>

          <div className="flex flex-col gap-3">
            <AnimatePresence>
              {cards.map((card, index) => {
                const meta = basketMeta(card.goalBasket);
                const Icon = meta.icon;
                const isExpanded = expandedId === card.id;
                const evalScore = scoreMap[card.id];

                const scores: { label: string; value: number; highlight?: boolean }[] = [
                  { label: "Confidence", value: Math.round(card.confidence * 100) },
                  { label: "Importance", value: Math.round(card.importance * 100) },
                  { label: "Urgency", value: Math.round(card.urgency * 100) },
                ];
                if (evalScore) {
                  scores.push({ label: "Overall", value: Math.round(evalScore.overall * 100), highlight: true });
                }

                const urgencyTag = card.urgency >= 0.85 ? "Urgent" : undefined;

                return (
                  <motion.div
                    key={card.id}
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ delay: index * 0.04, duration: 0.3 }}
                  >
                    <div
                      className="glass-card-strong p-4 relative cursor-pointer"
                      onClick={() => toggle(card.id)}
                    >
                      {/* X dismiss */}
                      <button
                        onClick={(e) => dismiss(card.id, card.goalBasket, e)}
                        className="absolute top-3 right-3 p-1 rounded-full hover:bg-foreground/10 transition-colors text-foreground/25 hover:text-foreground/60 z-10"
                      >
                        <X size={12} strokeWidth={2} />
                      </button>

                      {/* Category row */}
                      <div className="flex items-center gap-1.5 mb-2 pr-6">
                        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
                        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">
                          {meta.label}
                        </span>
                        {urgencyTag && (
                          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
                            {urgencyTag}
                          </span>
                        )}
                      </div>

                      {/* Title */}
                      <h3 className="text-display text-[15px] leading-snug text-foreground mb-1.5">
                        {card.title}
                      </h3>

                      {/* Description */}
                      <p className="text-[13px] text-foreground/70 leading-relaxed mb-0.5">
                        {card.whyNow || card.summary}
                      </p>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-foreground/55 leading-relaxed">
                          {card.sources.length > 0
                            ? `Sources: ${card.sources.join(" · ")}`
                            : ""}
                        </p>
                        <ChevronDown
                          size={14}
                          strokeWidth={1.5}
                          className={`text-foreground/25 transition-transform duration-300 shrink-0 ml-2 ${isExpanded ? "rotate-180" : ""}`}
                        />
                      </div>

                      {/* Expanded Detail */}
                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.3 }}
                            className="overflow-hidden"
                          >
                            {/* Scores */}
                            <div className={`grid gap-2 mb-3 ${scores.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
                              {scores.map((s) => (
                                <div key={s.label} className="rounded-xl bg-foreground/5 py-2 text-center">
                                  <div className={`text-base font-bold ${s.highlight ? "text-purple-600" : "text-foreground/80"}`}>
                                    {s.value}
                                  </div>
                                  <div className="text-[11px] text-foreground/45 mt-0.5">{s.label}</div>
                                </div>
                              ))}
                            </div>

                            {/* Summary */}
                            {card.summary && (
                              <div className="rounded-xl bg-green-50/60 border border-green-200/40 p-3 mb-3">
                                <div className="text-xs font-semibold text-green-700/80 mb-1">Summary</div>
                                <p className="text-[13px] text-foreground/80 leading-relaxed">{card.summary}</p>
                              </div>
                            )}

                            {/* Sources */}
                            {card.sources.length > 0 && (
                              <div className="mb-3">
                                <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-1.5">Sources</div>
                                {card.sources.map((src, i) => (
                                  <div key={i} className="flex items-start gap-1.5 mb-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-foreground/30 mt-1 shrink-0" />
                                    <span className="text-[13px] text-foreground/60">{src}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Actions from card */}
                            {(card.primaryAction || card.secondaryActions.length > 0) && (
                              <div className="mb-3">
                                <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-2">Available Actions</div>
                                <div className="flex flex-col gap-1.5">
                                  {card.primaryAction && (
                                    <div className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2">
                                      <Zap size={12} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
                                      <span className="text-[13px] text-foreground/70 flex-1">{card.primaryAction.label}</span>
                                      <span className="text-[11px] text-foreground/35 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">{card.primaryAction.type}</span>
                                    </div>
                                  )}
                                  {card.secondaryActions.map((action, i) => (
                                    <div key={i} className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2">
                                      <Pencil size={12} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
                                      <span className="text-[13px] text-foreground/70 flex-1">{action.label}</span>
                                      <span className="text-[11px] text-foreground/35 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">{action.type}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Evaluator feedback */}
                            {evalScore?.feedback && (
                              <p className="text-[13px] text-foreground/50 mb-3">
                                <span className="font-semibold text-foreground/65">Evaluator:</span> {evalScore.feedback}
                              </p>
                            )}

                            {/* Agent chain */}
                            {card.agentChain.length > 0 && (
                              <p className="text-[13px] text-foreground/50 mb-3">
                                <span className="font-semibold text-foreground/65">Agents:</span> {card.agentChain.join(" → ")}
                              </p>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {/* Actions */}
                      <div className="flex items-center gap-2.5 justify-end">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenChat?.(card.id);
                          }}
                          className="flex items-center justify-center p-2.5 rounded-xl hover:bg-foreground/10 transition-colors text-foreground/40 hover:text-foreground/70"
                          title="Chat"
                        >
                          <MessageCircle size={16} strokeWidth={1.5} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            recordFeedback({ kind: "card_action", action: "modify", intentCardId: card.id, basket: card.goalBasket });
                            setFeedbackCardId(card.id);
                            setTimeout(() => setFeedbackCardId(null), 2000);
                          }}
                          className={"flex items-center justify-center gap-2 px-7 py-2.5 rounded-xl transition-colors text-sm font-medium min-w-[100px] " + (feedbackCardId === card.id ? "bg-emerald-500/15 text-emerald-600" : "bg-foreground/5 hover:bg-foreground/10 text-foreground/50")}
                        >
                          {feedbackCardId === card.id ? (
                            <><Check size={13} strokeWidth={2} /> Noted</>
                          ) : (
                            <><Pencil size={13} strokeWidth={1.5} /> Modify</>
                          )}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            recordFeedback({ kind: "card_action", action: "confirm", intentCardId: card.id, basket: card.goalBasket });
                            onExecute(card.title);
                          }}
                          className="flex items-center justify-center gap-2 px-7 py-2.5 rounded-xl bg-foreground text-background text-sm font-semibold hover:bg-foreground/85 transition-colors min-w-[100px]"
                        >
                          <Zap size={13} strokeWidth={2} />
                          Confirm
                        </button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {hasMore && (
              <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                onClick={() => setVisibleCount((v) => v + 5)}
                className="w-full mt-2 py-3 rounded-2xl text-sm font-medium text-foreground/50 hover:text-foreground/70 bg-foreground/[0.03] hover:bg-foreground/[0.06] transition-colors"
              >
                Show {Math.min(allCards.length - visibleCount, 5)} more card{allCards.length - visibleCount === 1 ? "" : "s"}
                <span className="text-foreground/30 ml-1.5">
                  ({allCards.length - visibleCount} remaining)
                </span>
              </motion.button>
            )}
          </div>

          {showEmptyPrompt && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="glass-card-strong p-8 text-center"
            >
              <Sparkles size={28} className="mx-auto mb-3 text-foreground/50" />
              <p className="text-display text-foreground mb-1">No intent cards yet</p>
              <p className="text-sm text-muted-foreground mb-5">
                Generate AI-powered action recommendations from your data
              </p>
              <button
                onClick={onGenerate}
                disabled={isRunning}
                className="inline-flex items-center justify-center gap-2 px-8 py-3 rounded-2xl bg-foreground text-background text-sm font-semibold hover:bg-foreground/85 transition-colors disabled:opacity-50"
              >
                <Zap size={16} strokeWidth={2} />
                {isRunning ? "Generating..." : "Generate Intent Cards"}
              </button>
            </motion.div>
          )}

          {!showEmptyPrompt && !showLoadingOverlay && allCards.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="glass-card p-8 text-center breathing"
            >
              <Sparkles size={28} className="mx-auto mb-2 text-foreground/60" />
              <p className="text-display text-foreground">All caught up</p>
              <p className="text-sm text-muted-foreground mt-1">
                Your AI is watching for new intents
              </p>
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
