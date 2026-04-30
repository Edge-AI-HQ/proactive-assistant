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
import { GenerationIndicator } from "./GenerationIndicator";
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

  // NOW view layout. Cards stay mounted across swipes; reshuffling just
  // changes `currentLayoutIdx`, causing each card's `style.left/top` to
  // update. A CSS transition on left/top makes them drift smoothly to the
  // new slot — no fly-out, no unmount/remount.
  const [currentLayoutIdx, setCurrentLayoutIdx] = useState(() => Math.floor(Math.random() * SLOT_LAYOUTS.length));
  const touchStartY = useRef<number | null>(null);
  const touchStartX = useRef<number | null>(null);

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

  // ── Refresh Composio connections on Control tab entry ──
  // Keeps web and iOS in sync without a full app restart: when the user
  // switches to CONTROL, re-pull the live connection list. loadStatus is
  // intentionally omitted from the dep array — it's a useCallback whose
  // identity is stable per mount and listing it would refire on every render.

  useEffect(() => {
    if (activeView !== "control") return;
    void composio.loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);

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

  // ── Swipe-to-reshuffle (NOW view) ──

  const triggerReshuffle = useCallback(() => {
    setCurrentLayoutIdx((prev) => {
      const candidates = Array.from({ length: SLOT_LAYOUTS.length }, (_, i) => i).filter(i => i !== prev);
      return candidates[Math.floor(Math.random() * candidates.length)];
    });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    touchStartY.current = e.touches[0].clientY;
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === null || touchStartX.current === null) return;
    const deltaY = touchStartY.current - e.changedTouches[0].clientY;
    const deltaX = touchStartX.current - e.changedTouches[0].clientX;
    touchStartY.current = null;
    touchStartX.current = null;
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) > 80) {
      triggerReshuffle();
    }
  }, [triggerReshuffle]);

  // ── Render NOW view (floating cards around sphere) ──

  const renderNowView = () => {
    const positions = SLOT_LAYOUTS[currentLayoutIdx % SLOT_LAYOUTS.length];

    return (
      <div className="relative flex flex-col h-full">
        {/* Weather + Greeting */}
        <div className="relative z-20 px-5 pt-3 pb-2">
          {weather && (
            <div className="flex items-center gap-2 mb-3">
              <div className="glass-card-strong px-3 py-1.5 flex items-center gap-1.5 flex-nowrap whitespace-nowrap max-w-full">
                <weather.icon size={14} strokeWidth={1.5} className="text-foreground/60 shrink-0" />
                <span className="text-sm font-medium text-foreground shrink-0">{weather.temp}&deg;</span>
                <span className="text-xs text-foreground/60 shrink-0">{weather.label}</span>
                {weather.city && (
                  <>
                    <span className="text-xs text-foreground/20 shrink-0">&middot;</span>
                    <span className="text-xs text-foreground/50 shrink-0 truncate">{weather.city}</span>
                  </>
                )}
              </div>
              <GenerationIndicator />
            </div>
          )}
          {!weather && (
            <div className="mb-3">
              <GenerationIndicator />
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
            <AiSphere
              /* Sphere fills ~95% of viewport width (a small safe margin so
                 the edge never touches the screen). Capped at 460 so on
                 tablet/desktop the sphere sits neatly inside max-w-lg. */
              size={Math.min(window.innerWidth * 0.95, 460)}
              mode={isRunning ? "thinking" : "idle"}
              /* flex-1 sits below the weather+greeting header (~190px tall on
                 iPhone), so its vertical center is below the screen's true
                 center. The negative top margin pulls the sphere up by ~28%
                 of its own size, canceling the header offset so the sphere
                 reads as screen-centered. */
              className="-mt-[28%]"
            />
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

          {/* Empty-completion overlay: agent finished but produced no cards
              (typical for new users without connectors, or when the
              genericness filter rejected every candidate). batchFeedback,
              when present, explains why so the user isn't left guessing. */}
          {!isRunning && run.status === "complete" && visibleCards.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center z-20 px-6">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass-card-strong px-5 py-4 text-center max-w-[320px]"
              >
                <div className="flex items-center gap-2 justify-center mb-2">
                  <Sparkles size={14} className="text-foreground/50" />
                  <span className="text-sm font-medium text-foreground/80">
                    暂无新卡片
                  </span>
                </div>
                <p className="text-[12px] text-foreground/60 leading-relaxed">
                  {run.batchFeedback ??
                    "AI 分析后判断目前没有需要你处理的事项。连接更多数据源或稍后再试。"}
                </p>
              </motion.div>
            </div>
          )}

          {/* Floating cards. Cards stay mounted across swipes; left/top change
              on reshuffle and the CSS transition below slides them smoothly to
              their new slot. AnimatePresence only handles per-card dismissal
              (when a card is filtered out of visibleCards). */}
          <AnimatePresence mode="popLayout">
            {visibleCards.map((card, i) => {
              const pos = positions[card.slotIndex % positions.length];
              const meta = basketMeta(card.goalBasket);
              const CatIcon = meta.icon;
              const isNew = !seenCardIds.has(card.id);
              const isProcessing = processingIds.has(card.id);
              const floatDur = 6 + (i % 3) * 1.5;
              const floatDelay = i * 0.8;

              return (
                <motion.button
                  key={card.id}
                  drag="x"
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.4}
                  onDragEnd={(_e, info) => {
                    if (info.offset.x < -80) {
                      handleDismissCardById(card.id, card);
                    }
                  }}
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7, x: -300, transition: { duration: 0.25 } }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  onClick={() => handleCardTap(card)}
                  className={`absolute glass-card-strong px-2.5 py-2 cursor-pointer card-float ${
                    isNew ? "ring-1 ring-pink-400/40" : isProcessing ? "ring-1 ring-amber-400/40" : ""
                  }`}
                  style={{
                    left: `${pos.left}%`,
                    top: `calc(50% + ${pos.y}%)`,
                    width: `${33 + (parseInt(card.id.replace(/\D/g, ""), 10) % 4) * 5}%`,
                    maxWidth: 180,
                    minWidth: 110,
                    borderRadius: 16,
                    boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
                    zIndex: 10,
                    // Smooth drift to new slot on reshuffle. Using CSS
                    // transition on left/top means each card independently
                    // interpolates its position — GPU-friendly, no React
                    // work per frame.
                    transition: "left 0.75s cubic-bezier(0.22,1,0.36,1), top 0.75s cubic-bezier(0.22,1,0.36,1)",
                    willChange: "left, top, transform, opacity",
                    animationDuration: `${floatDur}s`,
                    animationDelay: `${floatDelay}s`,
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
        {/* Top-right buttons: DebugPanel gear + hamburger.
            Align vertically with the weather pill: weather pill sits at
            parent's padding-top (safe-area) + pt-3 (12px), so these
            absolute buttons need safe-area + 12px too. */}
        <div className="absolute top-[calc(env(safe-area-inset-top,0px)+12px)] right-4 z-30 flex items-center gap-2">
          <DebugPanel
            health={health}
            run={run}
            onGenerate={() => generate()}
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
              {activeView === "goals" && <GoalsView composio={composio} />}
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
