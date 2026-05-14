import { useCallback, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Pencil, Sparkles, X, Zap } from "lucide-react";

import type { Intent } from "@/types/constellation";
import { categoryFor } from "./categoryMeta";

interface NowFeedProps {
  /**
   * Cards to render. Caller owns the source of truth — feed renders the list
   * verbatim. Dismiss does NOT mutate this prop; caller decides whether to
   * hide via its own state after `onDismiss` fires.
   */
  intents: Intent[];
  onTap: (intent: Intent) => void;
  onApprove: (intent: Intent) => void;
  onModify?: (intent: Intent) => void;
  onDismiss?: (intent: Intent) => void;
  onScrollDirectionChange?: (direction: "up" | "down") => void;
  /**
   * Backdrop sitting BEHIND the scrollable card sheet. Default is an empty
   * placeholder; ConstellationLayout injects `<AiSphere />` here.
   */
  LandingOverride?: ComponentType;
  drawerStyle?: CSSProperties;
}

export default function NowFeed({
  intents,
  onTap,
  onApprove,
  onModify,
  onDismiss,
  onScrollDirectionChange,
  LandingOverride,
  drawerStyle,
}: NowFeedProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollY, setScrollY] = useState(0);
  const lastScrollTop = useRef(0);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const top = scrollRef.current.scrollTop;
    setScrollY(top);
    const delta = top - lastScrollTop.current;
    if (Math.abs(delta) > 3) {
      onScrollDirectionChange?.(delta > 0 ? "up" : "down");
    }
    lastScrollTop.current = top;
  }, [onScrollDirectionChange]);

  const toggle = (id: number) =>
    setExpandedId((prev) => (prev === id ? null : id));

  // Landing fades but bottoms out at 20% even when fully scrolled.
  const landingOpacity = Math.max(0.2, 1 - scrollY / 600);

  return (
    <div className="relative h-full overflow-hidden">
      <div
        className="absolute inset-x-0 top-0 z-0"
        style={{ opacity: landingOpacity, willChange: "opacity" }}
      >
        {LandingOverride ? <LandingOverride /> : null}
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative z-10 h-full overflow-y-auto"
        style={{ scrollBehavior: "smooth" }}
      >
        <div className="pointer-events-none" style={{ height: "60vh" }} />

        <div
          className="relative px-4 pb-4"
          style={
            drawerStyle ?? {
              borderRadius: "1.5rem 1.5rem 0 0",
              background:
                "linear-gradient(180deg, hsl(0 0% 100% / 0.15) 0%, hsl(0 0% 100% / 0.35) 120px, hsl(0 0% 100% / 0.5) 100%)",
              backdropFilter: "blur(40px)",
              WebkitBackdropFilter: "blur(40px)",
              minHeight: "80vh",
            }
          }
        >
          <div className="flex justify-center pt-3 pb-4">
            <div className="w-9 h-1 rounded-full bg-foreground/30" />
          </div>

          <div className="flex flex-col gap-3">
            <AnimatePresence>
              {intents.map((card, index) => {
                const cat = categoryFor(card.category);
                const Icon = cat.icon;
                const isExpanded = expandedId === card.id;
                const detail = card.detail;
                const hasScores = (detail?.scores?.length ?? 0) > 0;
                const hasPlan = (detail?.executionPlan?.length ?? 0) > 0;
                const hasSources = (detail?.dataSources?.length ?? 0) > 0;
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
                      onClick={() => {
                        toggle(card.id);
                        onTap(card);
                      }}
                    >
                      {onDismiss && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDismiss(card);
                          }}
                          className="absolute top-3 right-3 p-1 rounded-full hover:bg-foreground/10 transition-colors text-foreground/25 hover:text-foreground/60 z-10"
                          aria-label="Dismiss"
                        >
                          <X size={12} strokeWidth={2} />
                        </button>
                      )}

                      <div className="flex items-center gap-1.5 mb-2 pr-6">
                        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
                        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">
                          {cat.label}
                        </span>
                        {card.tag && (
                          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">
                            {card.tag}
                          </span>
                        )}
                      </div>

                      <h3 className="text-display text-[15px] leading-snug text-foreground mb-1.5">
                        {card.title}
                      </h3>

                      <p className="text-[13px] text-foreground/70 leading-relaxed mb-0.5">
                        {card.line1}
                      </p>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-foreground/55 leading-relaxed">
                          {card.line2}
                        </p>
                        <ChevronDown
                          size={14}
                          strokeWidth={1.5}
                          className={`text-foreground/25 transition-transform duration-300 shrink-0 ml-2 ${
                            isExpanded ? "rotate-180" : ""
                          }`}
                        />
                      </div>

                      <AnimatePresence>
                        {isExpanded && detail && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.3 }}
                            className="overflow-hidden"
                          >
                            {hasScores && (
                              <div
                                className="grid gap-2 mb-3"
                                style={{
                                  gridTemplateColumns: `repeat(${detail.scores.length}, minmax(0, 1fr))`,
                                }}
                              >
                                {detail.scores.map((s) => (
                                  <div
                                    key={s.label}
                                    className="rounded-xl bg-foreground/5 py-2 text-center"
                                  >
                                    <div className="text-base font-bold text-foreground/80">
                                      {s.value}
                                    </div>
                                    <div className="text-[11px] text-foreground/45 mt-0.5">
                                      {s.label}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {detail.willExecute && (
                              <div
                                className="rounded-xl p-3 mb-3 border border-pink-200/40"
                                style={{
                                  background:
                                    "linear-gradient(135deg, rgba(225,92,230,0.08) 0%, rgba(225,92,230,0.04) 100%)",
                                }}
                              >
                                <div className="text-xs font-semibold mb-1">
                                  <span className="bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
                                    Will execute on confirm
                                  </span>
                                </div>
                                <p className="text-[13px] text-foreground/80 leading-relaxed">
                                  {detail.willExecute}
                                </p>
                              </div>
                            )}

                            {hasPlan && (
                              <div className="mb-3">
                                <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-2">
                                  Execution Plan
                                </div>
                                <div className="flex flex-col gap-1.5">
                                  {detail.executionPlan.map((step, i) => (
                                    <div
                                      key={i}
                                      className="flex items-center gap-2 rounded-xl bg-foreground/[0.04] px-3 py-2"
                                    >
                                      <Zap
                                        size={12}
                                        strokeWidth={1.5}
                                        className="text-foreground/40 shrink-0"
                                      />
                                      <span className="text-[13px] text-foreground/70 flex-1">
                                        {step.text}
                                      </span>
                                      <span className="text-[11px] text-foreground/35 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">
                                        {step.tool}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {hasSources && (
                              <div className="mb-3">
                                <div className="text-xs font-semibold text-foreground/50 uppercase tracking-wide mb-1.5">
                                  Data Sources
                                </div>
                                {detail.dataSources.map((ds, i) => (
                                  <div key={i} className="flex items-start gap-1.5 mb-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-foreground/30 mt-1 shrink-0" />
                                    <span className="text-[13px] text-foreground/60">{ds}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {detail.impact && (
                              <p className="text-[13px] text-foreground/50 mb-1">
                                <span className="font-semibold text-foreground/65">Impact:</span>{" "}
                                {detail.impact}
                              </p>
                            )}
                            {detail.permissions && (
                              <p className="text-[13px] text-foreground/50 mb-3">
                                <span className="font-semibold text-foreground/65">
                                  Permissions:
                                </span>{" "}
                                {detail.permissions}
                              </p>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <div className="flex items-center gap-2.5 justify-end">
                        {onModify && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onModify(card);
                            }}
                            className="flex items-center justify-center gap-2 px-7 py-2.5 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-sm font-medium text-foreground/50 min-w-[100px]"
                          >
                            <Pencil size={13} strokeWidth={1.5} />
                            Modify
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onApprove(card);
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
          </div>

          {intents.length === 0 && (
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
