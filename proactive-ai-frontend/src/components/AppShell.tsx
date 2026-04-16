/**
 * AppShell — main layout once authenticated and container is running.
 * Combines the gateway's visual design (floating cards, hamburger menu,
 * weather widget, greeting) with the cloud frontend's API layer
 * (proxyFetch/proxyPost, Supabase auth, heartbeat).
 */

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Menu, X, Sparkles, Zap, MessageCircle, Target, Settings, ArrowRight,
} from "lucide-react";
import { heartbeat, proxyFetch, proxyPost } from "@/lib/api";
import { usePipeline } from "@/hooks/usePipeline";
import { useComposio } from "@/hooks/useComposio";
import { useWeather } from "@/hooks/useWeather";
import { basketMeta } from "@/lib/basket-meta";
import type { IntentCard, EvaluationScore } from "@/types/intent-card";
import NowFeed from "./NowFeed";
import ChatTimeline from "./ChatTimeline";
import GoalsView from "./GoalsView";
import ControlPanel from "./ControlPanel";
import DebugPanel from "./DebugPanel";
import CardChat from "./CardChat";
import CardDetailBody from "./CardDetailBody";
import AiSphere from "./AiSphere";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface AppShellProps {
  userName: string | null;
  onSignOut: () => void;
}

const MENU_ITEMS = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "chat", label: "CHAT", icon: MessageCircle },
  { id: "goals", label: "PROFILE", icon: Target },
  { id: "control", label: "CONTROL", icon: Settings },
] as const;
type MenuId = (typeof MENU_ITEMS)[number]["id"];

const HEARTBEAT_INTERVAL_MS = 60_000;

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

const AI_GREETINGS = [
  "Your 2pm meeting has been moved to 4pm",
  "A follow-up draft has been prepared for Alex",
  "Two threads are waiting for your input",
  "A $34,778 payroll charge just went through",
];

type FloatingCard = IntentCard & { slotIndex: number; exitDirection?: "left" | "scatter" };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AppShell({ userName, onSignOut }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<MenuId>(() => {
    const saved = sessionStorage.getItem("proactive-ai:activeView");
    return saved && ["now", "chat", "goals", "control"].includes(saved) ? saved as MenuId : "now";
  });
  const [iterations, setIterations] = useState(2);
  const [chatTarget, setChatTarget] = useState<{ card: IntentCard; score?: EvaluationScore | null } | null>(null);
  const [selectedCard, setSelectedCard] = useState<IntentCard | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Card status state — synced between NOW and CHAT views
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [chattedIds, setChattedIds] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem("proactive-ai:chattedCardIds");
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  });

  // NOW view layout + animation state
  const [currentLayoutIdx, setCurrentLayoutIdx] = useState(() => Math.floor(Math.random() * SLOT_LAYOUTS.length));
  const [scatterKey, setScatterKey] = useState(0);
  const [globalExitDirection, setGlobalExitDirection] = useState<"left" | "scatter">("scatter");
  const [gathered, setGathered] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const pinchStartDist = useRef<number | null>(null);
  const isScattering = useRef(false);

  // Track which cards are "new" (appeared in latest pipeline run)
  const [seenCardIds, setSeenCardIds] = useState<Set<string>>(new Set());

  // Greeting rotation
  const [greetIdx, setGreetIdx] = useState(0);

  const pipeline = usePipeline();
  const { health, run, generate, isRunning } = pipeline;
  const composio = useComposio();
  const weather = useWeather();

  // ── Heartbeat (keep container alive) ──

  const sendHeartbeat = useCallback(() => {
    heartbeat().catch((err) =>
      console.warn("[AppShell] heartbeat failed:", err),
    );
  }, []);

  useEffect(() => {
    sendHeartbeat();
    const id = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sendHeartbeat]);

  // ── Load dismissed IDs from backend on mount ──

  useEffect(() => {
    proxyFetch("/feedback/dismissed")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.dismissedCardIds)) {
          setDismissedIds(new Set(data.dismissedCardIds));
        }
      })
      .catch(() => {});
  }, []);

  // ── Greeting cross-fade (5s interval) ──

  useEffect(() => {
    const t = setInterval(() => setGreetIdx((p) => (p + 1) % AI_GREETINGS.length), 5000);
    return () => clearInterval(t);
  }, []);

  // ── Visible cards for NOW view ──

  const hiddenIds = new Set([...dismissedIds, ...doneIds]);
  const visibleCards: FloatingCard[] = run.finalCards
    .filter((c) => !hiddenIds.has(c.id))
    .slice(0, 8)
    .map((c, i) => ({ ...c, slotIndex: i }));

  // Mark new cards when pipeline produces results
  useEffect(() => {
    if (run.finalCards.length === 0) return;
    const currentIds = new Set(run.finalCards.map((c) => c.id));
    const newIds = new Set<string>();
    for (const id of currentIds) {
      if (!seenCardIds.has(id)) newIds.add(id);
    }
    if (newIds.size > 0) {
      setSeenCardIds(currentIds);
      const timer = setTimeout(() => {
        setSeenCardIds((prev) => {
          const next = new Set(prev);
          for (const id of newIds) next.add(id);
          return next;
        });
      }, 10000);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.finalCards]);

  // ── Card action handlers ──

  const persistChatted = useCallback((cardId: string) => {
    setChattedIds((prev) => {
      const next = new Set(prev).add(cardId);
      sessionStorage.setItem("proactive-ai:chattedCardIds", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const handleCardTap = useCallback((card: IntentCard) => {
    if (processingIds.has(card.id)) {
      persistChatted(card.id);
      setChatTarget({ card, score: run.scoreMap[card.id] ?? null });
      return;
    }
    setSelectedCard(card);
    setDrawerOpen(true);
  }, [processingIds, run.scoreMap, persistChatted]);

  const handleDismissCard = useCallback(() => {
    if (selectedCard) {
      setDismissedIds((prev) => new Set(prev).add(selectedCard.id));
      proxyPost("/feedback", {
        kind: "dismiss",
        intentCardId: selectedCard.id,
        basket: selectedCard.goalBasket,
        channel: "web",
      }).catch(() => {});
    }
    setDrawerOpen(false);
    setSelectedCard(null);
  }, [selectedCard]);

  const handleDismissCardById = useCallback((cardId: string, card?: IntentCard) => {
    setDismissedIds((prev) => new Set(prev).add(cardId));
    if (card) {
      proxyPost("/feedback", {
        kind: "dismiss",
        intentCardId: cardId,
        basket: card.goalBasket,
        channel: "web",
      }).catch(() => {});
    }
  }, []);

  const handleConfirmCard = useCallback(() => {
    if (selectedCard) {
      const cardId = selectedCard.id;
      setConfirmedIds((prev) => new Set(prev).add(cardId));
      setProcessingIds((prev) => new Set(prev).add(cardId));
      proxyPost("/feedback", {
        kind: "card_action",
        action: "confirm",
        intentCardId: cardId,
        basket: selectedCard.goalBasket,
        channel: "web",
      }).catch(() => {});
      persistChatted(cardId);
      setChatTarget({ card: selectedCard, score: run.scoreMap[cardId] ?? null });
    }
    setDrawerOpen(false);
    setSelectedCard(null);
  }, [selectedCard, run.scoreMap, persistChatted]);

  const handleDoneCard = useCallback(() => {
    if (selectedCard) {
      const cardId = selectedCard.id;
      setDoneIds((prev) => new Set(prev).add(cardId));
      setProcessingIds((prev) => { const n = new Set(prev); n.delete(cardId); return n; });
      proxyPost("/feedback", {
        kind: "card_action",
        action: "complete",
        intentCardId: cardId,
        basket: selectedCard.goalBasket,
        channel: "web",
      }).catch(() => {});
    }
    setDrawerOpen(false);
    setSelectedCard(null);
  }, [selectedCard]);

  const handleSnoozeCard = useCallback(() => {
    if (selectedCard) {
      proxyPost("/feedback", {
        kind: "snooze",
        intentCardId: selectedCard.id,
        basket: selectedCard.goalBasket,
        channel: "web",
      }).catch(() => {});
      setDismissedIds((prev) => new Set(prev).add(selectedCard.id));
    }
    setDrawerOpen(false);
    setSelectedCard(null);
  }, [selectedCard]);

  const handleModifyCard = useCallback(() => {
    if (selectedCard) {
      proxyPost("/feedback", {
        kind: "card_action",
        action: "modify",
        intentCardId: selectedCard.id,
        basket: selectedCard.goalBasket,
        channel: "web",
      }).catch(() => {});
      setProcessingIds((prev) => new Set(prev).add(selectedCard.id));
      persistChatted(selectedCard.id);
      setChatTarget({ card: selectedCard, score: run.scoreMap[selectedCard.id] ?? null });
    }
    setDrawerOpen(false);
    setSelectedCard(null);
  }, [selectedCard, run.scoreMap, persistChatted]);

  const handleTextFeedback = useCallback((text: string) => {
    if (selectedCard) {
      proxyPost("/feedback", {
        kind: "text_feedback",
        intentCardId: selectedCard.id,
        basket: selectedCard.goalBasket,
        channel: "web",
        text,
      }).catch(() => {});
    }
  }, [selectedCard]);

  const handleOpenChatFromDrawer = useCallback(() => {
    if (selectedCard) {
      const cardId = selectedCard.id;
      setProcessingIds((prev) => new Set(prev).add(cardId));
      persistChatted(cardId);
      setChatTarget({ card: selectedCard, score: run.scoreMap[cardId] ?? null });
    }
    setDrawerOpen(false);
    setSelectedCard(null);
  }, [selectedCard, run.scoreMap, persistChatted]);

  const handleOpenChatDirect = useCallback((card: IntentCard) => {
    setProcessingIds((prev) => new Set(prev).add(card.id));
    persistChatted(card.id);
    setChatTarget({ card, score: null });
  }, [persistChatted]);

  const handleMenuNav = (id: MenuId) => {
    setActiveView(id);
    sessionStorage.setItem("proactive-ai:activeView", id);
    setChatTarget(null);
    setMenuOpen(false);
  };

  // ── Swipe refresh handlers (NOW view) ──

  const handleSwipeRefresh = useCallback((direction: "left" | "scatter") => {
    if (isScattering.current) return;
    isScattering.current = true;
    setGlobalExitDirection(direction);
    setScatterKey((k) => k + 1);

    setTimeout(() => {
      setGlobalExitDirection("scatter");
      setCurrentLayoutIdx((prev) => {
        const candidates = Array.from({ length: SLOT_LAYOUTS.length }, (_, i) => i).filter(i => i !== prev);
        return candidates[Math.floor(Math.random() * candidates.length)];
      });
      isScattering.current = false;
    }, 400);
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDist.current = Math.sqrt(dx * dx + dy * dy);
      touchStartX.current = null;
      touchStartY.current = null;
    } else if (e.touches.length === 1) {
      touchStartY.current = e.touches[0].clientY;
      touchStartX.current = e.touches[0].clientX;
      pinchStartDist.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (pinchStartDist.current !== null && e.changedTouches.length >= 1) {
      const remaining = e.touches;
      if (remaining.length === 1) {
        const dx = e.changedTouches[0].clientX - remaining[0].clientX;
        const dy = e.changedTouches[0].clientY - remaining[0].clientY;
        const endDist = Math.sqrt(dx * dx + dy * dy);
        const delta = endDist - pinchStartDist.current;
        if (delta < -50) setGathered(true);
        else if (delta > 50) setGathered(false);
      } else if (remaining.length === 0 && e.changedTouches.length === 2) {
        const dx = e.changedTouches[0].clientX - e.changedTouches[1].clientX;
        const dy = e.changedTouches[0].clientY - e.changedTouches[1].clientY;
        const endDist = Math.sqrt(dx * dx + dy * dy);
        const delta = endDist - pinchStartDist.current;
        if (delta < -50) setGathered(true);
        else if (delta > 50) setGathered(false);
      }
      pinchStartDist.current = null;
      return;
    }

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

  // ── Render NOW view (floating cards around sphere) ──

  const renderNowView = () => {
    const positions = SLOT_LAYOUTS[currentLayoutIdx % SLOT_LAYOUTS.length];

    return (
      <div className="relative flex flex-col h-full">
        {/* Weather + Greeting */}
        <div className="relative z-20 px-5 pt-3 pb-2">
          {weather && (
            <div className="flex items-center mb-3">
              <div className="glass-card-strong px-3 py-1.5 flex items-center gap-1.5">
                <weather.icon size={14} strokeWidth={1.5} className="text-foreground/60" />
                <span className="text-sm font-medium text-foreground">{weather.temp}&deg;</span>
                <span className="text-xs text-foreground/60">{weather.label}</span>
                {weather.city && (
                  <>
                    <span className="text-foreground/20">&middot;</span>
                    <span className="text-xs text-foreground/50">{weather.city}</span>
                  </>
                )}
              </div>
            </div>
          )}
          <h1 className="text-2xl font-light text-foreground leading-tight">
            Hi,{" "}
            <span className="font-semibold bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
              {userName ?? "there"}
            </span>
          </h1>
          <div className="h-[28px] overflow-hidden mt-1">
            <AnimatePresence mode="wait">
              <motion.p
                key={greetIdx}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.4 }}
                className="text-base font-medium text-foreground/80 flex items-center gap-1.5 cursor-pointer"
              >
                {AI_GREETINGS[greetIdx]}
                <ArrowRight size={16} strokeWidth={2.5} className="text-foreground/70 shrink-0" />
              </motion.p>
            </AnimatePresence>
          </div>
        </div>

        {/* Sphere + floating cards */}
        <div
          className="flex-1 relative flex items-center justify-center overflow-hidden"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <Suspense fallback={<div className="w-[300px] h-[300px] rounded-full bg-foreground/5 animate-pulse" />}>
            <AiSphere size={Math.min(570, window.innerWidth * 1.42)} mode={isRunning ? "thinking" : "idle"} className="-mt-[10%]" />
          </Suspense>

          {/* Loading overlay */}
          {isRunning && visibleCards.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center z-20">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-card-strong px-6 py-4 text-center"
              >
                <div className="flex items-center gap-2 justify-center">
                  <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}>
                    <Sparkles size={16} className="text-foreground/60" />
                  </motion.div>
                  <span className="text-sm font-medium text-foreground/80">
                    {run.activePhase === "evaluating" ? "Evaluating cards..." : run.activePhase === "planning" ? "Planning intents..." : "Generating cards..."}
                  </span>
                </div>
              </motion.div>
            </div>
          )}

          {/* Floating cards */}
          <AnimatePresence mode="popLayout">
            {visibleCards.map((card, i) => {
              const pos = positions[card.slotIndex % positions.length];
              const meta = basketMeta(card.goalBasket);
              const CatIcon = meta.icon;
              const isNew = !seenCardIds.has(card.id);
              const isProcessing = processingIds.has(card.id);

              const cardCenterX = pos.left + 20;
              const cardCenterY = 50 + pos.y;
              const dx = cardCenterX - 50;
              const dy = cardCenterY - 50;
              const mag = Math.sqrt(dx * dx + dy * dy) || 1;
              const exitX = (dx / mag) * 400;
              const exitY = (dy / mag) * 400;

              const flyLeft = card.exitDirection === "left" || globalExitDirection === "left";
              const floatDur = 6 + (i % 3) * 1.5;
              const floatDelay = i * 0.8;

              const gatheredLeft = 36 + (i % 2 === 0 ? -2 : 2) + (i % 3) * 1.5;
              const gatheredY = -6 + i * 1.2;
              const gatheredRotate = (i % 2 === 0 ? -1 : 1) * (2 + (i % 4));

              return (
                <motion.button
                  key={`float-${card.id}-${scatterKey}`}
                  drag={gathered ? false : "x"}
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.4}
                  onDragEnd={(_e, info) => {
                    if (info.offset.x < -80) {
                      handleDismissCardById(card.id, card);
                    }
                  }}
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: gathered ? 0.85 : 1 }}
                  exit={flyLeft ? {
                    opacity: 0,
                    scale: 0.7,
                    x: -350,
                    rotate: -12,
                    transition: { duration: 0.3, ease: [0.4, 0, 1, 1], delay: i * 0.03 },
                  } : {
                    opacity: 0,
                    scale: 0.7,
                    x: exitX,
                    y: exitY,
                    rotate: (i % 2 === 0 ? 1 : -1) * (8 + i % 10),
                    transition: { duration: 0.3, ease: [0.4, 0, 1, 1], delay: i * 0.03 },
                  }}
                  transition={{ duration: 0.4, ease: "easeOut", delay: i * 0.04 }}
                  onClick={() => handleCardTap(card)}
                  className={`absolute glass-card-strong px-2.5 py-2 cursor-pointer card-float ${
                    isNew ? "ring-1 ring-pink-400/40" : isProcessing ? "ring-1 ring-amber-400/40" : ""
                  }`}
                  style={{
                    left: gathered ? `${gatheredLeft}%` : `${pos.left}%`,
                    top: gathered ? `calc(50% + ${gatheredY}%)` : `calc(50% + ${pos.y}%)`,
                    width: `${33 + (parseInt(card.id.replace(/\D/g, ""), 10) % 4) * 5}%`,
                    maxWidth: 180,
                    minWidth: 110,
                    borderRadius: 16,
                    boxShadow: gathered
                      ? "0 4px 20px rgba(0,0,0,0.1)"
                      : "0 2px 12px rgba(0,0,0,0.06)",
                    zIndex: gathered ? 10 + i : 10,
                    transform: gathered ? `rotate(${gatheredRotate}deg)` : undefined,
                    transition: "left 0.45s cubic-bezier(0.22,1,0.36,1), top 0.45s cubic-bezier(0.22,1,0.36,1), box-shadow 0.3s ease",
                    willChange: "transform, opacity, left, top",
                    animationDuration: `${floatDur}s`,
                    animationDelay: `${floatDelay}s`,
                    animationPlayState: gathered ? "paused" : "running",
                  }}
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <CatIcon size={12} strokeWidth={1.5} className="text-foreground/50" />
                    <span className="text-[10px] font-semibold tracking-wide text-foreground/50 uppercase truncate">
                      {meta.label}
                    </span>
                    {isNew && (
                      <span className="text-[9px] font-bold text-pink-500 uppercase tracking-wider">new</span>
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
      </div>
    );
  };

  // ── Main render ──

  return (
    <div className="relative h-screen w-full max-w-lg mx-auto overflow-hidden">
      {/* Background: gradient image + animated overlay + white overlay */}
      <img
        src={`${import.meta.env.BASE_URL}bg-gradient.jpg`}
        alt=""
        className="absolute inset-0 w-full h-full object-cover opacity-80"
        aria-hidden="true"
      />
      <div className="absolute inset-0 animate-bg-flow opacity-25" />
      <div className="absolute inset-0 bg-white/50" />

      <div className="relative z-10 flex flex-col h-full pt-safe-top">
        {/* Top-right buttons: DebugPanel gear + hamburger */}
        <div className="absolute top-[max(env(safe-area-inset-top,0px),12px)] right-4 z-30 flex items-center gap-2">
          <DebugPanel
            health={health}
            run={run}
            iterations={iterations}
            onIterationsChange={setIterations}
            onGenerate={() => generate(iterations)}
            isRunning={isRunning}
          />
          <button
            onClick={() => setMenuOpen(true)}
            className="p-2 rounded-full glass-card-strong"
          >
            <Menu size={20} strokeWidth={1.5} className="text-foreground/70" />
          </button>
        </div>

        {/* Main content area */}
        <AnimatePresence mode="wait">
          {chatTarget ? (
            <motion.div
              key={`chat-${chatTarget.card.id}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 overflow-hidden"
            >
              <CardChat
                card={chatTarget.card}
                score={chatTarget.score}
                onBack={() => setChatTarget(null)}
              />
            </motion.div>
          ) : activeView === "now" ? (
            <motion.div
              key="now"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 overflow-hidden"
            >
              {renderNowView()}
            </motion.div>
          ) : (
            <motion.div
              key={activeView}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="flex-1 min-h-0"
            >
              {activeView === "chat" && (
                <ChatTimeline
                  onOpenChat={handleOpenChatDirect}
                  dismissedIds={dismissedIds}
                  confirmedIds={confirmedIds}
                  processingIds={processingIds}
                  doneIds={doneIds}
                  chattedIds={chattedIds}
                  onDismissId={(id) => setDismissedIds((prev) => new Set(prev).add(id))}
                  onConfirmId={(id) => {
                    setConfirmedIds((prev) => new Set(prev).add(id));
                    setProcessingIds((prev) => new Set(prev).add(id));
                  }}
                  onDoneId={(id) => {
                    setDoneIds((prev) => new Set(prev).add(id));
                    setProcessingIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
                  }}
                  onProcessingId={(id) => setProcessingIds((prev) => new Set(prev).add(id))}
                  onChattedId={persistChatted}
                />
              )}
              {activeView === "goals" && <GoalsView />}
              {activeView === "control" && <ControlPanel composio={composio} />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Hamburger side menu (slides from right) */}
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-foreground/10 backdrop-blur-sm"
              onClick={() => setMenuOpen(false)}
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 300 }}
              className="fixed top-0 right-0 bottom-0 z-50 w-56"
              style={{
                background: "linear-gradient(180deg, hsl(0 0% 100% / 0.85) 0%, hsl(0 0% 100% / 0.95) 100%)",
                backdropFilter: "blur(48px) saturate(1.5)",
                WebkitBackdropFilter: "blur(48px) saturate(1.5)",
                borderLeft: "1px solid hsl(0 0% 100% / 0.5)",
              }}
            >
              <div className="pt-safe-top px-5">
                <div className="flex items-center justify-between mb-4">
                  <button onClick={() => setMenuOpen(false)} className="p-1.5 rounded-full hover:bg-foreground/[0.08]">
                    <X size={20} strokeWidth={1.5} className="text-foreground/60" />
                  </button>
                </div>
                {userName && (
                  <div className="mb-6 px-1">
                    <p className="text-sm font-medium text-foreground truncate">{userName}</p>
                    <button
                      onClick={() => { setMenuOpen(false); onSignOut(); }}
                      className="text-xs text-foreground/35 hover:text-foreground/60 transition-colors mt-1"
                    >
                      Sign out
                    </button>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  {MENU_ITEMS.map((item) => {
                    const MIcon = item.icon;
                    const isActive = activeView === item.id && !chatTarget;
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleMenuNav(item.id)}
                        className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                          isActive ? "bg-foreground/[0.08] text-foreground" : "text-foreground/50 hover:bg-foreground/[0.04]"
                        }`}
                      >
                        <MIcon size={18} strokeWidth={isActive ? 2 : 1.5} />
                        <span className={`text-sm tracking-wider ${isActive ? "font-semibold" : "font-medium"}`}>
                          {item.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Card detail drawer (Vaul) */}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
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
            <DrawerTitle>{selectedCard?.title ?? "Card Detail"}</DrawerTitle>
            <DrawerDescription>Intent card detail view</DrawerDescription>
          </DrawerHeader>
          {selectedCard && (
            <CardDetailBody
              card={selectedCard}
              score={run.scoreMap[selectedCard.id] ?? null}
              onChat={handleOpenChatFromDrawer}
              onDismiss={handleDismissCard}
              onConfirm={handleConfirmCard}
              onSnooze={handleSnoozeCard}
              onModify={handleModifyCard}
              onDone={handleDoneCard}
              onTextFeedback={handleTextFeedback}
              enableSwipe
            />
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
