/**
 * AppShell — main layout once authenticated and container is running.
 * Renders the tab-based UI (Now, Chat, Goals, Settings) with glass-morphism design.
 * Manages full-screen overlays: CardChat, ExecutionView, VoicePage, MainChat.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, MessageCircle, MessageSquare, Target, Settings } from "lucide-react";
import { heartbeat } from "@/lib/api";
import { usePipeline } from "@/hooks/usePipeline";
import { useComposio } from "@/hooks/useComposio";
import type { IntentCard } from "@/types/intent-card";
import NowFeed from "./NowFeed";
import ChatTimeline from "./ChatTimeline";
import GoalsView from "./GoalsView";
import ControlPanel from "./ControlPanel";
import DebugPanel from "./DebugPanel";
import CardChat from "./CardChat";
import ExecutionView from "./ExecutionView";
import VoicePage from "./VoicePage";
import MainChat from "./MainChat";

interface AppShellProps {
  userName: string | null;
  onSignOut: () => void;
}

const tabs = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "chat", label: "CHAT", icon: MessageCircle },
  { id: "goals", label: "PROFILE", icon: Target },
  { id: "settings", label: "SETTINGS", icon: Settings },
] as const;

type TabId = (typeof tabs)[number]["id"];

const HEARTBEAT_INTERVAL_MS = 60_000;

export default function AppShell({ userName, onSignOut }: AppShellProps) {
  const [activeTab, setActiveTab] = useState<TabId>("now");
  const [tabBarVisible, setTabBarVisible] = useState(true);
  const pipeline = usePipeline();
  const composio = useComposio();

  // Overlay state
  const [chatTarget, setChatTarget] = useState<IntentCard | null>(null);
  const [executingIntent, setExecutingIntent] = useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [mainChatOpen, setMainChatOpen] = useState(false);
  const [iterations, setIterations] = useState(1);

  // Heartbeat every 60s to keep the container alive
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

  const handleScrollDirection = useCallback((direction: "up" | "down") => {
    setTabBarVisible(direction === "down");
  }, []);

  const handleOpenChat = useCallback((card: IntentCard) => {
    setChatTarget(card);
  }, []);

  const handleExecute = useCallback((title: string) => {
    setExecutingIntent(title);
  }, []);

  return (
    <div className="relative w-full h-full max-w-2xl mx-auto overflow-hidden">
      {/* Animated gradient background */}
      <div className="absolute inset-0 animate-bg-flow opacity-60" />
      <div className="absolute inset-0 bg-white/20" />

      {/* Top-right controls */}
      <div className="absolute top-3 right-3 z-30 flex items-center gap-2">
        <button
          onClick={() => setMainChatOpen(true)}
          className="p-1.5 rounded-lg hover:bg-foreground/10 transition-colors"
          aria-label="Open chat"
        >
          <MessageSquare size={16} strokeWidth={1.8} className="text-foreground/50" />
        </button>
        <DebugPanel
          health={pipeline.health}
          run={pipeline.run}
          isRunning={pipeline.isRunning}
          iterations={iterations}
          onIterationsChange={setIterations}
          onGenerate={() => pipeline.generate(iterations)}
        />
        {userName && (
          <span className="text-xs text-foreground/50">{userName}</span>
        )}
        <button
          onClick={onSignOut}
          className="text-xs text-foreground/35 hover:text-foreground/60 transition-colors"
        >
          Sign out
        </button>
      </div>

      <div className="relative z-10 flex flex-col h-full">
        {/* Content area */}
        <AnimatePresence mode="wait">
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
                cards={pipeline.run.finalCards}
                scoreMap={pipeline.run.scoreMap}
                runId={pipeline.run.runId}
                isRunning={pipeline.isRunning}
                activePhase={pipeline.run.activePhase}
                onExecute={handleExecute}
                onScrollDirectionChange={handleScrollDirection}
                onOpenChat={handleOpenChat}
                onGenerate={() => pipeline.generate(iterations)}
                onTapToSpeak={() => setVoiceOpen(true)}
              />
            )}
            {activeTab === "chat" && (
              <ChatTimeline onOpenChat={handleOpenChat} />
            )}
            {activeTab === "goals" && <GoalsView />}
            {activeTab === "settings" && (
              <ControlPanel composio={composio} />
            )}
          </motion.div>
        </AnimatePresence>

        {/* Full-screen overlays */}
        <AnimatePresence>
          {chatTarget && (
            <CardChat
              key="card-chat"
              card={chatTarget}
              score={pipeline.run.scoreMap[chatTarget.id] ?? null}
              onBack={() => setChatTarget(null)}
            />
          )}
          {executingIntent && (
            <ExecutionView
              key="execution"
              intentTitle={executingIntent}
              onBack={() => setExecutingIntent(null)}
            />
          )}
          {voiceOpen && (
            <VoicePage
              key="voice"
              onBack={() => setVoiceOpen(false)}
            />
          )}
          {mainChatOpen && (
            <MainChat
              key="main-chat"
              onBack={() => setMainChatOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* Glass tab bar — auto-hide on scroll */}
        <motion.div
          initial={false}
          animate={{
            y: tabBarVisible ? 0 : 80,
            opacity: tabBarVisible ? 1 : 0,
          }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="absolute bottom-0 left-0 right-0 z-20 pb-safe-bottom"
        >
          <nav
            className="mx-3 px-2 py-2 flex justify-around items-center"
            role="tablist"
            aria-label="Main navigation"
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
              const isActive = activeTab === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={isActive}
                  aria-label={tab.label}
                  onClick={() => setActiveTab(tab.id)}
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
          </nav>
        </motion.div>
      </div>
    </div>
  );
}
