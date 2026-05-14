import { useState } from "react";
import { motion } from "framer-motion";
import bgGradient from "@/assets/bg-gradient.jpg";
import NowFeedTwoColumns from "./NowFeedTwoColumns";
import GoalsView from "./GoalsView";
import ChatTimeline from "./ChatTimeline";
import ControlPanel from "./ControlPanel";
import ExecutionView from "./ExecutionView";
import { Zap, MessageCircle, Target, Settings } from "lucide-react";
import { AnimatePresence } from "framer-motion";

const tabs = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "chat", label: "CHAT", icon: MessageCircle },
  { id: "goals", label: "GOALS", icon: Target },
  { id: "control", label: "CONTROL", icon: Settings },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function AppLayoutTwoColumns() {
  const [activeTab, setActiveTab] = useState<TabId>("now");
  const [executingIntent, setExecutingIntent] = useState<string | null>(null);

  return (
    <div className="relative h-screen w-full max-w-md mx-auto overflow-hidden">
      <img src={bgGradient} alt="" className="absolute inset-0 w-full h-full object-cover" aria-hidden="true" />
      <div className="absolute inset-0 bg-white/50" />

      <div className="relative z-10 flex flex-col h-full">
        <AnimatePresence mode="wait">
          {executingIntent ? (
            <motion.div key="execution" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 overflow-hidden">
              <ExecutionView intentTitle={executingIntent} onBack={() => setExecutingIntent(null)} />
            </motion.div>
          ) : (
            <motion.div key={activeTab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="flex-1 overflow-hidden">
              {activeTab === "now" && <NowFeedTwoColumns onExecute={(title) => setExecutingIntent(title)} />}
              {activeTab === "chat" && <ChatTimeline />}
              {activeTab === "goals" && <GoalsView />}
              {activeTab === "control" && <ControlPanel />}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="glass-card-strong mx-3 mb-3 px-2 py-2 flex justify-around items-center" style={{ borderRadius: "1.5rem" }}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id && !executingIntent;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setExecutingIntent(null); }}
                className="flex flex-col items-center gap-1 px-4 py-1.5 rounded-xl transition-all duration-300 relative"
              >
                <Icon size={20} className={`transition-all duration-300 ${isActive ? "text-foreground" : "text-foreground/40"}`}
                  {...(isActive
                    ? { strokeWidth: 2.5 }
                    : { strokeWidth: 1.5 }
                  )} />
                <span className={`text-[10px] font-medium tracking-wider transition-all duration-300 ${isActive ? "text-foreground" : "text-foreground/40"}`}>
                  {tab.label}
                </span>
                {isActive && (
                  <motion.div layoutId="tab-dot-2col" className="absolute -bottom-0.5 w-1 h-1 rounded-full bg-foreground"
                    transition={{ type: "spring", stiffness: 400, damping: 30 }} />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
