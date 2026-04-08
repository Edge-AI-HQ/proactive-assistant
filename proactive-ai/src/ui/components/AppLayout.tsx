import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import bgGradient from "@/assets/bg-gradient.jpg";
import NowFeed from "./NowFeed";
import GoalsView from "./GoalsView";
import ChatTimeline from "./ChatTimeline";
import ControlPanel from "./ControlPanel";
import ExecutionView from "./ExecutionView";
import DebugPanel from "./DebugPanel";
import CardChat from "./CardChat";
import VoicePage from "./VoicePage";
import { usePipeline, type IntentCard, type EvaluationScore } from "@/hooks/use-pipeline";
import { useComposio } from "@/hooks/use-composio";
import { Zap, MessageCircle, Target, Settings } from "lucide-react";

const tabs = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "chat", label: "CHAT", icon: MessageCircle },
  { id: "goals", label: "GOALS", icon: Target },
  { id: "control", label: "CONTROL", icon: Settings },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function AppLayout() {
  const [activeTab, setActiveTab] = useState<TabId>("now");
  const [executingIntent, setExecutingIntent] = useState<string | null>(null);
  const [tabBarVisible, setTabBarVisible] = useState(true);
  const [iterations, setIterations] = useState(2);
  const [chatTarget, setChatTarget] = useState<{ card: IntentCard; score?: EvaluationScore | null } | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);

  const { health, run, generate, isRunning } = usePipeline();
  const composio = useComposio();

  // Signal Electron main process that the UI is ready (gateway reachable).
  // Fires once; the main process uses this to dismiss the splash screen.
  const readySignaled = useRef(false);
  useEffect(() => {
    if (health.ok && !readySignaled.current) {
      readySignaled.current = true;
      window.electronAPI?.notifyReady();
    }
  }, [health.ok]);

  const handleScrollDirection = (direction: "up" | "down") => {
    setTabBarVisible(direction === "down");
  };

  const handleOpenChat = (cardId: string) => {
    const card = run.finalCards.find((c) => c.id === cardId);
    if (card) setChatTarget({ card, score: run.scoreMap[cardId] ?? null });
  };

  const handleOpenChatFromTimeline = (card: IntentCard) => {
    setChatTarget({ card, score: null });
  };

  return (
    <div className="relative h-screen w-full max-w-md mx-auto overflow-hidden">
      {/* Background image + flowing color overlay */}
      <img
        src={bgGradient}
        alt=""
        className="absolute inset-0 w-full h-full object-cover"
        aria-hidden="true"
      />
      <div className="absolute inset-0 animate-bg-flow opacity-40" />
      <div className="absolute inset-0 bg-white/30" />

      {/* Debug Panel trigger — top-right corner */}
      <div className="absolute top-[calc(0.75rem+env(safe-area-inset-top,0px))] right-3 z-30">
        <DebugPanel
          health={health}
          run={run}
          iterations={iterations}
          onIterationsChange={setIterations}
          onGenerate={() => generate(iterations)}
          isRunning={isRunning}
        />
      </div>

      <div className="relative z-10 flex flex-col h-full">
        <AnimatePresence mode="wait">
          {executingIntent ? (
            <motion.div
              key="execution"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 overflow-hidden"
            >
              <ExecutionView
                intentTitle={executingIntent}
                onBack={() => setExecutingIntent(null)}
              />
            </motion.div>
          ) : (
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="flex-1 overflow-hidden"
            >
              {activeTab === "now" && (
                <NowFeed
                  onExecute={(title) => setExecutingIntent(title)}
                  onScrollDirectionChange={handleScrollDirection}
                  cards={run.finalCards}
                  scoreMap={run.scoreMap}
                  runId={run.runId}
                  isRunning={isRunning}
                  activePhase={run.activePhase}
                  onOpenChat={handleOpenChat}
                  onGenerate={() => generate(iterations)}
                  onTapToSpeak={() => setVoiceOpen(true)}
                />
              )}
              {activeTab === "chat" && (
                <ChatTimeline
                  onOpenChat={handleOpenChatFromTimeline}
                />
              )}
              {activeTab === "goals" && <GoalsView />}
              {activeTab === "control" && <ControlPanel composio={composio} />}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Per-card chat overlay */}
        <AnimatePresence>
          {chatTarget && (
            <CardChat
              key={chatTarget.card.id}
              card={chatTarget.card}
              score={chatTarget.score}
              onBack={() => setChatTarget(null)}
            />
          )}
        </AnimatePresence>

        {/* Voice overlay */}
        <AnimatePresence>
          {voiceOpen && (
            <VoicePage onBack={() => setVoiceOpen(false)} />
          )}
        </AnimatePresence>

        {/* Tab Bar — auto-hide on scroll */}
        <motion.div
          initial={false}
          animate={{
            y: tabBarVisible ? 0 : 80,
            opacity: tabBarVisible ? 1 : 0,
          }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="absolute bottom-0 left-0 right-0 z-20"
          style={{
            paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
          }}
        >
          <div
            className="mx-3 px-2 py-2 flex justify-around items-center"
            style={{
              borderRadius: "1.5rem",
              background:
                "linear-gradient(180deg, hsl(0 0% 100% / 0.55) 0%, hsl(0 0% 100% / 0.75) 100%)",
              backdropFilter: "blur(40px) saturate(1.5)",
              WebkitBackdropFilter: "blur(40px) saturate(1.5)",
              border: "1px solid hsl(0 0% 100% / 0.4)",
              boxShadow: "0 -4px 30px hsl(0 0% 0% / 0.06)",
            }}
          >
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id && !executingIntent;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setExecutingIntent(null);
                  }}
                  className="flex flex-col items-center gap-1 px-4 py-1.5 rounded-xl transition-all duration-300 relative"
                >
                  <Icon
                    size={20}
                    className={`transition-all duration-300 ${
                      isActive ? "text-foreground" : "text-foreground/40"
                    }`}
                    {...(isActive
                      ? { strokeWidth: 2.5 }
                      : { strokeWidth: 1.5 })}
                  />
                  <span
                    className={`text-[10px] font-medium tracking-wider transition-all duration-300 ${
                      isActive ? "text-foreground" : "text-foreground/40"
                    }`}
                  >
                    {tab.label}
                  </span>
                  {isActive && (
                    <motion.div
                      layoutId="tab-dot"
                      className="absolute -bottom-0.5 w-1 h-1 rounded-full bg-foreground"
                      transition={{
                        type: "spring",
                        stiffness: 400,
                        damping: 30,
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
