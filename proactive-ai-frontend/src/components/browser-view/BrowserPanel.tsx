import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Globe, ChevronUp } from "lucide-react";
import BrowserView from "./BrowserView";

interface BrowserSession {
  browserSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  controlMode: "ai" | "user" | "idle";
}

interface BrowserPanelProps {
  session: BrowserSession | null;
  onControlChange: (mode: "ai" | "user") => void;
  onClose: () => void;
  onExpandedChange?: (expanded: boolean) => void;
}

export default function BrowserPanel({
  session,
  onControlChange,
  onClose,
  onExpandedChange,
}: BrowserPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  const expanded = !!session && !collapsed;
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  // Auto-expand when a new session arrives
  useEffect(() => {
    if (session) setCollapsed(false);
  }, [session?.browserSessionId]);

  if (!session) return null;

  return (
    <AnimatePresence mode="wait">
      {collapsed ? (
        <div className="shrink-0 flex justify-center py-2">
          <motion.button
            key="browser-pill"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            onClick={() => setCollapsed(false)}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/80 backdrop-blur-md text-white/80 text-[12px] hover:bg-black/90 transition-colors shadow-lg"
          >
            <Globe size={14} />
            <span>Browser</span>
            <ChevronUp size={14} className="text-white/50" />
          </motion.button>
        </div>
      ) : (
        <motion.div
          key="browser-panel"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 30, stiffness: 300 }}
          style={{ flex: "0 0 60%" }}
        >
          <BrowserView
            liveViewUrl={session.liveViewUrl}
            sessionId={session.browserSessionId}
            controlMode={session.controlMode === "idle" ? "ai" : session.controlMode}
            onControlChange={onControlChange}
            onCollapse={() => setCollapsed(true)}
            onClose={onClose}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
