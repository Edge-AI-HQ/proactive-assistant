import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import bgGradient from "@/assets/bg-gradient.jpg";
import NowFeed from "./NowFeed";
import GoalsView from "./GoalsView";
import ChatTimeline from "./ChatTimeline";
import ControlPanel from "./ControlPanel";
import ChatDetailView, { type ChatCard } from "./ChatDetailView";
import AmbientView from "./AmbientView";
import { Zap, MessageCircle, Target, Settings, Radio } from "lucide-react";

const tabs = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "ambient", label: "AMBIENT", icon: Radio },
  { id: "control", label: "CONTROL", icon: Settings },
  { id: "chat", label: "CHAT", icon: MessageCircle },
  { id: "goals", label: "GOALS", icon: Target },
] as const;

type TabId = (typeof tabs)[number]["id"];

interface AppLayoutProps {
  defaultTab?: TabId;
}

export default function AppLayout({ defaultTab = "now" }: AppLayoutProps) {
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const [tabBarVisible, setTabBarVisible] = useState(true);

  // Card-originated chats
  const [cardChats, setCardChats] = useState<ChatCard[]>([]);
  const [activeChat, setActiveChat] = useState<ChatCard | null>(null);
  const [chatMode, setChatMode] = useState<"confirm" | "modify" | "done">("confirm");
  const chatEntryTab = useRef<TabId>("now");

  const handleScrollDirection = (direction: "up" | "down") => {
    setTabBarVisible(direction === "down");
  };

  const handleExecute = (card: ChatCard) => {
    setCardChats((prev) => {
      if (prev.find((c) => c.id === card.id)) return prev;
      return [card, ...prev];
    });
    chatEntryTab.current = activeTab;
    setChatMode("confirm");
    setActiveChat(card);
  };

  const handleModify = (card: ChatCard) => {
    setCardChats((prev) => {
      if (prev.find((c) => c.id === card.id)) return prev;
      return [card, ...prev];
    });
    chatEntryTab.current = activeTab;
    setChatMode("modify");
    setActiveChat(card);
  };

  const handleOpenChat = (card: ChatCard, status?: string) => {
    setChatMode(status === "processing" ? "confirm" : "done");
    setActiveChat(card);
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

      <div className="relative z-10 flex flex-col h-full">
        <AnimatePresence mode="wait">
          {activeChat ? (
            <motion.div
              key={`chat-detail-${activeChat.id}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 overflow-hidden"
            >
              <ChatDetailView
                card={activeChat}
                onBack={() => {
                  const returnTo = chatEntryTab.current;
                  setActiveChat(null);
                  setActiveTab(returnTo);
                }}
                mode={chatMode}
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
                  onExecute={handleExecute}
                  onModify={handleModify}
                  onScrollDirectionChange={handleScrollDirection}
                />
              )}
              {activeTab === "chat" && (
                <ChatTimeline
                  cardChats={cardChats}
                  onOpenChat={handleOpenChat}
                />
              )}
              {activeTab === "ambient" && <AmbientView onConnectMore={() => setActiveTab("control")} />}
              {activeTab === "goals" && <GoalsView />}
              {activeTab === "control" && <ControlPanel />}
            </motion.div>
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
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
        >
          <div
            className="mx-3 px-2 py-2 flex justify-around items-center"
            style={{
              borderRadius: "1.5rem",
              background: "linear-gradient(180deg, hsl(0 0% 100% / 0.55) 0%, hsl(0 0% 100% / 0.75) 100%)",
              backdropFilter: "blur(40px) saturate(1.5)",
              WebkitBackdropFilter: "blur(40px) saturate(1.5)",
              border: "1px solid hsl(0 0% 100% / 0.4)",
              boxShadow: "0 -4px 30px hsl(0 0% 0% / 0.06)",
            }}
          >
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id && !activeChat;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setActiveChat(null);
                  }}
                  className="flex flex-col items-center gap-1 px-3 py-1.5 rounded-xl transition-all duration-300 relative"
                >
                  <Icon
                    size={20}
                    className={`transition-all duration-300 ${
                      isActive ? "text-foreground" : "text-foreground/40"
                    }`}
                    {...(isActive ? { strokeWidth: 2.5 } : { strokeWidth: 1.5 })}
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
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
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
