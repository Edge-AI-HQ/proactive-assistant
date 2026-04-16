import { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles } from "lucide-react";
import { basketMeta } from "@/lib/basket-meta";
import type { IntentCard, EvaluationScore } from "@/types/intent-card";
import AiSphere from "./AiSphere";

// ---------------------------------------------------------------------------
// Slot layouts — 4 variants with left% / y% offsets for floating cards
// ---------------------------------------------------------------------------

const SLOT_LAYOUTS = [
  [
    { left: 3, y: -42 }, { left: 48, y: -34 }, { left: 20, y: -18 },
    { left: 55, y: -8 }, { left: 2, y: 6 }, { left: 40, y: 14 },
    { left: 15, y: 30 }, { left: 52, y: 36 },
  ],
  [
    { left: 8, y: -40 }, { left: 52, y: -30 }, { left: 5, y: -14 },
    { left: 48, y: -4 }, { left: 12, y: 10 }, { left: 55, y: 20 },
    { left: 2, y: 32 }, { left: 44, y: 40 },
  ],
  [
    { left: 2, y: -38 }, { left: 3, y: -20 }, { left: 50, y: -36 },
    { left: 52, y: -12 }, { left: 8, y: 4 }, { left: 48, y: 8 },
    { left: 4, y: 28 }, { left: 50, y: 30 },
  ],
  [
    { left: 45, y: -44 }, { left: 6, y: -30 }, { left: 50, y: -16 },
    { left: 3, y: -2 }, { left: 46, y: 12 }, { left: 8, y: 22 },
    { left: 48, y: 34 }, { left: 5, y: 42 },
  ],
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NowFeedProps {
  cards: IntentCard[];
  scoreMap: Record<string, EvaluationScore>;
  isRunning: boolean;
  activePhase: string | null;
  onCardTap: (card: IntentCard) => void;
  onDismissCard: (cardId: string, card?: IntentCard) => void;
  dismissedIds: Set<string>;
  doneIds: Set<string>;
  processingIds: Set<string>;
  seenCardIds: Set<string>;
}

type FloatingCard = IntentCard & { slotIndex: number };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NowFeed({
  cards: incomingCards,
  scoreMap: _scoreMap,
  isRunning,
  activePhase,
  onCardTap,
  onDismissCard,
  dismissedIds,
  doneIds,
  processingIds,
  seenCardIds,
}: NowFeedProps) {
  const [currentLayoutIdx, setCurrentLayoutIdx] = useState(
    () => Math.floor(Math.random() * SLOT_LAYOUTS.length),
  );
  const [scatterKey, setScatterKey] = useState(0);
  const [globalExitDirection, setGlobalExitDirection] = useState<"left" | "scatter">("scatter");

  const touchStartY = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const isScattering = useRef(false);

  // Build visible floating cards (max 8, excluding dismissed/done)
  const hiddenIds = new Set([...dismissedIds, ...doneIds]);
  const visibleCards: FloatingCard[] = incomingCards
    .filter((c) => !hiddenIds.has(c.id))
    .slice(0, 8)
    .map((c, i) => ({ ...c, slotIndex: i }));

  const positions = SLOT_LAYOUTS[currentLayoutIdx % SLOT_LAYOUTS.length];

  // ── Swipe refresh ──

  const handleSwipeRefresh = useCallback((direction: "left" | "scatter") => {
    if (isScattering.current) return;
    isScattering.current = true;
    setGlobalExitDirection(direction);
    setScatterKey((k) => k + 1);

    setTimeout(() => {
      setGlobalExitDirection("scatter");
      setCurrentLayoutIdx((prev) => {
        const candidates = Array.from(
          { length: SLOT_LAYOUTS.length },
          (_, i) => i,
        ).filter((i) => i !== prev);
        return candidates[Math.floor(Math.random() * candidates.length)];
      });
      isScattering.current = false;
    }, 600);
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === null || touchStartX.current === null) return;
    const deltaY = touchStartY.current - e.changedTouches[0].clientY;
    const deltaX = touchStartX.current - e.changedTouches[0].clientX;
    touchStartY.current = null;
    touchStartX.current = null;
    if (deltaX > 80 && Math.abs(deltaX) > Math.abs(deltaY)) {
      handleSwipeRefresh("left");
    } else if (Math.abs(deltaY) > 80) {
      handleSwipeRefresh("scatter");
    }
  }, [handleSwipeRefresh]);

  const showLoadingOverlay = isRunning && visibleCards.length === 0;

  return (
    <div
      className="flex-1 relative flex items-center justify-center overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Centered AI Sphere */}
      <AiSphere
        size={Math.min(570, window.innerWidth * 1.42)}
        mode={isRunning ? "thinking" : "idle"}
        className="-mt-[10%]"
      />

      {/* Loading overlay when pipeline running with no cards */}
      {showLoadingOverlay && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-card-strong px-6 py-4 text-center"
          >
            <div className="flex items-center gap-2 justify-center">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
              >
                <Sparkles size={16} className="text-foreground/60" />
              </motion.div>
              <span className="text-sm font-medium text-foreground/80">
                {activePhase === "evaluating"
                  ? "Evaluating cards\u2026"
                  : activePhase === "planning"
                    ? "Planning intents\u2026"
                    : "Generating cards\u2026"}
              </span>
            </div>
          </motion.div>
        </div>
      )}

      {/* Floating cards */}
      <AnimatePresence>
        {visibleCards.map((card, i) => {
          const pos = positions[card.slotIndex % positions.length];
          const meta = basketMeta(card.goalBasket);
          const CatIcon = meta.icon;
          const delay = i * 1.1;
          const dur = 7 + (i % 3) * 1.5;
          const isNew = !seenCardIds.has(card.id);
          const isProcessing = processingIds.has(card.id);

          const cardCenterX = pos.left + 20;
          const cardCenterY = 50 + pos.y;
          const dx = cardCenterX - 50;
          const dy = cardCenterY - 50;
          const mag = Math.sqrt(dx * dx + dy * dy) || 1;
          const exitX = (dx / mag) * 400;
          const exitY = (dy / mag) * 400;

          const flyLeft = globalExitDirection === "left";

          return (
            <motion.button
              key={`float-${card.id}-${scatterKey}`}
              layout
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.4}
              onDragEnd={(_e, info) => {
                if (info.offset.x < -80) {
                  onDismissCard(card.id, card);
                }
              }}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{
                opacity: 1,
                scale: [1, 1.045, 1, 0.97, 1],
                y: [0, -3.5, 0, 2, 0],
                x: [0, 1.5, 0, -1.5, 0],
              }}
              exit={
                flyLeft
                  ? {
                      opacity: 0,
                      scale: 0.6,
                      x: -400,
                      rotate: -15,
                      transition: { duration: 0.4, ease: [0.4, 0, 1, 1] },
                    }
                  : {
                      opacity: 0,
                      scale: 0.6,
                      x: exitX,
                      y: exitY,
                      rotate: (i % 2 === 0 ? 1 : -1) * (10 + (i % 15)),
                      transition: { duration: 0.45, ease: [0.4, 0, 1, 1] },
                    }
              }
              transition={{
                opacity: { duration: 0.8 },
                scale: {
                  duration: dur + 1,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: delay + 0.3,
                },
                y: {
                  duration: dur,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay,
                },
                x: {
                  duration: dur + 2,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: delay + 0.5,
                },
              }}
              onClick={() => onCardTap(card)}
              className={`absolute glass-card-strong px-2.5 py-2 cursor-pointer hover:scale-105 transition-transform z-10 ${
                isNew
                  ? "ring-1 ring-pink-400/40"
                  : isProcessing
                    ? "ring-1 ring-amber-400/40"
                    : ""
              }`}
              style={{
                left: `${pos.left}%`,
                top: `calc(50% + ${pos.y}%)`,
                width: `${33 + (parseInt(card.id.replace(/\D/g, ""), 10) % 4) * 5}%`,
                maxWidth: 180,
                minWidth: 110,
                borderRadius: 16,
                boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
              }}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <CatIcon
                  size={12}
                  strokeWidth={1.5}
                  className="text-foreground/50"
                />
                <span className="text-[10px] font-semibold tracking-wide text-foreground/50 uppercase truncate">
                  {meta.label}
                </span>
                {isNew && (
                  <span className="text-[9px] font-bold text-pink-500 uppercase tracking-wider">
                    new
                  </span>
                )}
                {isProcessing && (
                  <span className="shrink-0 w-2.5 h-2.5 rounded-full border-[1.5px] border-amber-400 border-t-transparent animate-spin" />
                )}
              </div>
              <p className="text-[13px] font-medium text-foreground leading-snug line-clamp-3 text-left">
                {card.title}
              </p>
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
