import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import bgGradient from "@/assets/bg-gradient.jpg";
import AiSphere from "./AiSphere";
import GoalsView from "./GoalsView";
import ChatTimeline from "./ChatTimeline";
import ControlPanel from "./ControlPanel";
import DebugPanel from "./DebugPanel";
import CardChat from "./CardChat";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { usePipeline, type IntentCard, type EvaluationScore } from "@/hooks/use-pipeline";
import { useComposio } from "@/hooks/use-composio";
import { apiFetch, apiPost } from "@/lib/api";
import {
  Menu, X, Zap, MessageCircle, Target, Settings,
  Sprout, Briefcase, TrendingUp, Heart, Sparkles, Users,
  ArrowRight, Pencil,
  type LucideIcon,
} from "lucide-react";

const MENU_ITEMS = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "chat", label: "CHAT", icon: MessageCircle },
  { id: "goals", label: "GOALS", icon: Target },
  { id: "control", label: "CONTROL", icon: Settings },
] as const;
type MenuId = (typeof MENU_ITEMS)[number]["id"];

const BASKET_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  work: { icon: Briefcase, label: "Work" },
  health: { icon: Heart, label: "Health" },
  family: { icon: Users, label: "Family" },
  wealth: { icon: TrendingUp, label: "Finance" },
  finance: { icon: TrendingUp, label: "Finance" },
  growth: { icon: Sprout, label: "Growth" },
  life: { icon: Sparkles, label: "Life" },
};
const FALLBACK_BASKET = { icon: Sparkles, label: "General" };
function basketMeta(key: string) {
  return BASKET_ICONS[key?.toLowerCase()] ?? FALLBACK_BASKET;
}

const SLOT_LAYOUTS = [
  [
    { left: 3, y: -42 }, { left: 48, y: -34 }, { left: 20, y: -18 },
    { left: 55, y: -8 }, { left: 2, y: 6 }, { left: 40, y: 14 },
    { left: 15, y: 30 }, { left: 52, y: 36 }, { left: 5, y: 52 }, { left: 36, y: 56 },
  ],
  [
    { left: 8, y: -40 }, { left: 52, y: -30 }, { left: 5, y: -14 },
    { left: 48, y: -4 }, { left: 12, y: 10 }, { left: 55, y: 20 },
    { left: 2, y: 32 }, { left: 44, y: 40 }, { left: 18, y: 50 }, { left: 50, y: 58 },
  ],
  [
    { left: 2, y: -38 }, { left: 3, y: -20 }, { left: 50, y: -36 },
    { left: 52, y: -12 }, { left: 8, y: 4 }, { left: 48, y: 8 },
    { left: 4, y: 28 }, { left: 50, y: 30 }, { left: 20, y: 46 }, { left: 38, y: 54 },
  ],
  [
    { left: 45, y: -44 }, { left: 6, y: -30 }, { left: 50, y: -16 },
    { left: 3, y: -2 }, { left: 46, y: 12 }, { left: 8, y: 22 },
    { left: 48, y: 34 }, { left: 5, y: 42 }, { left: 42, y: 52 }, { left: 15, y: 58 },
  ],
];

const AI_GREETINGS = [
  "Your 2pm meeting has been moved to 4pm",
  "A follow-up draft has been prepared for Alex",
  "Two threads are waiting for your input",
  "A $34,778 payroll charge just went through",
];

type FloatingCard = IntentCard & { slotIndex: number };

function CardDrawerBody({
  card,
  score,
  onChat,
  onDismiss,
}: {
  card: IntentCard;
  score?: EvaluationScore | null;
  onChat: () => void;
  onDismiss: () => void;
}) {
  const meta = basketMeta(card.goalBasket);
  const Icon = meta.icon;

  const scores: { label: string; value: number; highlight?: boolean }[] = [
    { label: "Confidence", value: Math.round(card.confidence * 100) },
    { label: "Importance", value: Math.round(card.importance * 100) },
    { label: "Urgency", value: Math.round(card.urgency * 100) },
  ];
  if (score) {
    scores.push({ label: "Overall", value: Math.round(score.overall * 10), highlight: true });
  }

  return (
    <motion.div
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.3}
      onDragEnd={(_e, info) => {
        if (info.offset.x < -100) onDismiss();
        if (info.offset.x > 100) onChat();
      }}
      className="px-5 pb-6 pt-2 overflow-y-auto max-h-[75vh]"
    >
      {/* Swipe hints */}
      <div className="flex justify-between mb-3 px-2">
        <span className="text-[10px] text-foreground/25">← swipe to dismiss</span>
        <span className="text-[10px] text-foreground/25">swipe to chat →</span>
      </div>

      {/* Category */}
      <div className="flex items-center gap-1.5 mb-2">
        <Icon size={14} strokeWidth={1.5} className="text-foreground/50" />
        <span className="text-xs font-semibold tracking-wide text-foreground/50 uppercase">{meta.label}</span>
        {card.urgency >= 0.85 && (
          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-foreground/10 text-foreground/50">Urgent</span>
        )}
      </div>

      {/* Title */}
      <h3 className="text-display text-[18px] leading-snug text-foreground mb-2.5 font-semibold">{card.title}</h3>

      {/* Description */}
      <p className="text-[15px] text-foreground/70 leading-relaxed mb-1.5">{card.whyNow}</p>
      <p className="text-[13px] text-foreground/55 leading-relaxed mb-4">Sources: {card.sources.join(" · ")}</p>

      {/* Scores */}
      <div className={`grid gap-2 mb-4 ${scores.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
        {scores.map((s) => (
          <div key={s.label} className="rounded-xl bg-foreground/5 py-2.5 text-center">
            <div className={`text-lg font-bold ${s.highlight ? "text-purple-600" : "text-foreground/80"}`}>{s.value}</div>
            <div className="text-[12px] text-foreground/50 mt-0.5 font-medium">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Will execute */}
      {card.primaryAction && (
        <div className="rounded-xl p-4 mb-4 border border-pink-200/40" style={{ background: "linear-gradient(135deg, rgba(225,92,230,0.08) 0%, rgba(225,92,230,0.04) 100%)" }}>
          <div className="text-[13px] font-bold mb-1.5 flex items-center gap-1.5">
            <Zap size={13} strokeWidth={2} color="hsl(292,78%,63%)" />
            <span className="bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">Will execute on confirm</span>
          </div>
          <p className="text-[15px] text-foreground font-medium leading-relaxed">{card.primaryAction.label}</p>
        </div>
      )}

      {/* Secondary actions as execution plan */}
      {card.secondaryActions.length > 0 && (
        <div className="mb-4">
          <div className="text-[13px] font-bold text-foreground uppercase tracking-wide mb-2">Actions</div>
          <div className="flex flex-col gap-1.5">
            {card.secondaryActions.map((action, i) => (
              <div key={i} className="flex items-center gap-2 rounded-xl bg-foreground/4 px-3 py-2.5">
                <ArrowRight size={13} strokeWidth={1.5} className="text-foreground/40 shrink-0" />
                <span className="text-[14px] text-foreground/65 flex-1">{action.label}</span>
                <span className="text-[11px] text-foreground/35 bg-foreground/5 px-2 py-0.5 rounded-full whitespace-nowrap">{action.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data Sources */}
      {card.sources.length > 0 && (
        <div className="mb-4 rounded-xl bg-foreground/[0.04] border border-foreground/[0.06] p-3.5">
          <div className="text-[13px] font-bold text-foreground/60 uppercase tracking-wide mb-2">Data Sources</div>
          {card.sources.map((ds, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5 last:mb-0">
              <span className="w-2 h-2 rounded-full bg-foreground/25 mt-1.5 shrink-0" />
              <span className="text-[14px] text-foreground/65 leading-relaxed">{ds}</span>
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      {card.summary && (
        <p className="text-[14px] text-foreground/55 mb-1.5">
          <span className="font-bold text-foreground/70">Summary:</span> {card.summary}
        </p>
      )}

      {/* Evaluator feedback */}
      {score?.feedback && (
        <p className="text-[14px] text-foreground/55 mb-4">
          <span className="font-bold text-foreground/70">Evaluator:</span> {score.feedback}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2.5">
        <button
          onClick={onDismiss}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-foreground/5 hover:bg-foreground/10 transition-colors text-sm font-medium text-foreground/50"
        >
          <Pencil size={13} strokeWidth={1.5} />
          Dismiss
        </button>
        <button
          onClick={onChat}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-foreground text-background text-sm font-semibold hover:bg-foreground/85 transition-colors"
        >
          <MessageCircle size={13} strokeWidth={2} />
          Chat
        </button>
      </div>
    </motion.div>
  );
}

export default function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<MenuId>("now");
  const [iterations, setIterations] = useState(2);
  const [chatTarget, setChatTarget] = useState<{ card: IntentCard; score?: EvaluationScore | null } | null>(null);
  const [selectedCard, setSelectedCard] = useState<IntentCard | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [currentLayoutIdx] = useState(() => Math.floor(Math.random() * SLOT_LAYOUTS.length));

  const { health, run, generate, isRunning } = usePipeline();
  const composio = useComposio();

  const readySignaled = useRef(false);
  useEffect(() => {
    if (health.ok && !readySignaled.current) {
      readySignaled.current = true;
      window.electronAPI?.notifyReady();
    }
  }, [health.ok]);

  useEffect(() => {
    apiFetch("/api/feedback/dismissed")
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.dismissedCardIds)) {
          setDismissedIds(new Set(data.dismissedCardIds));
        }
      })
      .catch(() => {});
  }, []);

  const [greetIdx, setGreetIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setGreetIdx((p) => (p + 1) % AI_GREETINGS.length), 5000);
    return () => clearInterval(t);
  }, []);

  const visibleCards: FloatingCard[] = run.finalCards
    .filter((c) => !dismissedIds.has(c.id))
    .slice(0, 10)
    .map((c, i) => ({ ...c, slotIndex: i }));

  const handleCardTap = useCallback((card: IntentCard) => {
    setSelectedCard(card);
    setDrawerOpen(true);
  }, []);

  const handleDismissCard = useCallback(() => {
    if (selectedCard) {
      const cardId = selectedCard.id;
      setDismissedIds((prev) => new Set(prev).add(cardId));
      apiPost("/api/feedback", {
        kind: "dismiss",
        intentCardId: cardId,
        basket: selectedCard.goalBasket,
        channel: "web",
      }).catch(() => {});
    }
    setDrawerOpen(false);
    setSelectedCard(null);
  }, [selectedCard]);

  const handleOpenChatFromDrawer = useCallback(() => {
    if (selectedCard) {
      setChatTarget({ card: selectedCard, score: run.scoreMap[selectedCard.id] ?? null });
    }
    setDrawerOpen(false);
    setSelectedCard(null);
  }, [selectedCard, run.scoreMap]);

  const handleOpenChatDirect = useCallback((card: IntentCard) => {
    setChatTarget({ card, score: null });
  }, []);

  const handleMenuNav = (id: MenuId) => {
    setActiveView(id);
    setChatTarget(null);
    setMenuOpen(false);
  };

  const renderNowView = () => {
    const positions = SLOT_LAYOUTS[currentLayoutIdx % SLOT_LAYOUTS.length];

    return (
      <div className="relative flex flex-col h-full">
        {/* Greeting */}
        <div className="relative z-20 px-5 pt-24 pb-2">
          <h1 className="text-2xl font-light text-foreground leading-tight">
            Hi,{" "}
            <span className="font-semibold bg-gradient-to-r from-[hsl(292,78%,63%)] to-[hsl(330,80%,65%)] bg-clip-text text-transparent">
              Cherub
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
        <div className="flex-1 relative flex items-center justify-center overflow-hidden">
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
          <AnimatePresence>
            {visibleCards.map((card, i) => {
              const pos = positions[card.slotIndex % positions.length];
              const meta = basketMeta(card.goalBasket);
              const CatIcon = meta.icon;
              const delay = i * 1.1;
              const dur = 7 + (i % 3) * 1.5;

              return (
                <motion.button
                  key={card.id}
                  layout
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{
                    opacity: 1,
                    scale: [1, 1.04, 1, 0.97, 1],
                    y: [0, -3.5, 0, 2, 0],
                    x: [0, 1.5, 0, -1.5, 0],
                  }}
                  exit={{ opacity: 0, scale: 0.6, x: -300, rotate: -15, transition: { duration: 0.4 } }}
                  transition={{
                    opacity: { duration: 0.8 },
                    scale: { duration: dur + 1, repeat: Infinity, ease: "easeInOut", delay: delay + 0.3 },
                    y: { duration: dur, repeat: Infinity, ease: "easeInOut", delay },
                    x: { duration: dur + 2, repeat: Infinity, ease: "easeInOut", delay: delay + 0.5 },
                  }}
                  onClick={() => handleCardTap(card)}
                  className="absolute glass-card-strong px-2.5 py-2 cursor-pointer hover:scale-105 transition-transform z-10"
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
                    <CatIcon size={12} strokeWidth={1.5} className="text-foreground/50" />
                    <span className="text-[10px] font-semibold tracking-wide text-foreground/50 uppercase truncate">
                      {meta.label}
                    </span>
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

  return (
    <div className="relative h-screen w-full max-w-md mx-auto overflow-hidden">
      {/* Background */}
      <img src={bgGradient} alt="" className="absolute inset-0 w-full h-full object-cover opacity-80" aria-hidden="true" />
      <div className="absolute inset-0 animate-bg-flow opacity-25" />
      <div className="absolute inset-0 bg-white/50" />

      <div className="relative z-10 flex flex-col h-full">
        {/* Top-right buttons */}
        <div className="absolute top-14 right-4 z-30 flex items-center gap-2">
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

        {/* Main content */}
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
              className="flex-1 overflow-hidden"
            >
              {activeView === "chat" && <ChatTimeline onOpenChat={handleOpenChatDirect} />}
              {activeView === "goals" && <GoalsView />}
              {activeView === "control" && <ControlPanel composio={composio} />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Hamburger side menu */}
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
              <div className="pt-14 px-5">
                <button onClick={() => setMenuOpen(false)} className="mb-8 p-1.5 rounded-full hover:bg-foreground/[0.08]">
                  <X size={20} strokeWidth={1.5} className="text-foreground/60" />
                </button>
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

      {/* Card detail drawer */}
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
            <CardDrawerBody
              card={selectedCard}
              score={run.scoreMap[selectedCard.id] ?? null}
              onChat={handleOpenChatFromDrawer}
              onDismiss={handleDismissCard}
            />
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
