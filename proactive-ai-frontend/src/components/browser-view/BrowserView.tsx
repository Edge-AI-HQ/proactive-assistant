import { useState } from "react";
import { Loader2, Hand, Bot, ChevronDown, X } from "lucide-react";

interface BrowserViewProps {
  liveViewUrl: string;
  sessionId: string;
  controlMode: "ai" | "user" | "idle";
  onControlChange: (mode: "ai" | "user") => void;
  onCollapse: () => void;
  onClose: () => void;
}

export default function BrowserView({
  liveViewUrl,
  sessionId,
  controlMode,
  onControlChange,
  onCollapse,
  onClose,
}: BrowserViewProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);

  return (
    <div className="flex flex-col h-full w-full bg-black/90 rounded-t-2xl overflow-hidden">
      {/* Control bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-black/60 backdrop-blur-md">
        <div className="flex items-center gap-2">
          {controlMode === "ai" ? (
            <button
              onClick={() => onControlChange("user")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/80 text-[12px] transition-colors"
            >
              <Hand size={14} />
              Take Control
            </button>
          ) : (
            <button
              onClick={() => onControlChange("ai")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/30 hover:bg-blue-500/40 text-blue-200 text-[12px] transition-colors"
            >
              <Bot size={14} />
              Return to AI
            </button>
          )}
          <span className="text-[11px] text-white/40">
            {controlMode === "ai" ? "AI is browsing" : "You have control"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onCollapse}
            className="p-1.5 rounded-lg hover:bg-white/10 text-white/60 transition-colors"
            title="Collapse"
          >
            <ChevronDown size={16} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 text-white/60 transition-colors"
            title="Close browser"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Iframe */}
      <div className="relative flex-1">
        {!iframeLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <div className="flex items-center gap-2">
              <Loader2 size={16} className="animate-spin text-white/50" />
              <span className="text-[13px] text-white/50">Loading browser...</span>
            </div>
          </div>
        )}
        <iframe
          src={liveViewUrl}
          onLoad={() => setIframeLoaded(true)}
          className="w-full h-full border-0"
          allow="clipboard-read; clipboard-write"
          title={`Browser session ${sessionId}`}
        />
      </div>
    </div>
  );
}
