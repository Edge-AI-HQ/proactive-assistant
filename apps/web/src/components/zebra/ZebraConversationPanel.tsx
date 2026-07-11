import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { conversationInit } from "@pin-ai/core";
import { ConversationView, MinimalistLanding } from "@/ui-web";

/**
 * zebra conversation 面板体 —— proactive-ai-frontend MainChat 的桌面装配
 * （同一套真实链路：conversationInit 解析用户的 main 单例 thread →
 * MinimalistLanding 空态 orb → ConversationView（agent_core frames SSE）。
 * 两面常驻挂载（CSS 切换），landing → conversation 过渡不打断在途流。
 * zebra 桌面化：右上角浮动 expand（560px ⇄ focus 全屏），onBack = 关面板。
 */
export default function ZebraConversationPanel({
  onClose,
  expanded,
  onToggleExpand,
  onBrowserSplitChange,
}: {
  onClose: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  /** Bubbles ConversationView's browser-split state up so the shell can
   *  widen this panel to full width (browser live view beside the chat). */
  onBrowserSplitChange?: (active: boolean) => void;
}) {
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [view, setView] = useState<"landing" | "conversation">("landing");
  const [bootstrap, setBootstrap] = useState<string | undefined>(undefined);

  // Resolve the user's singleton main thread once on mount. A thread that
  // already has history lands directly in the conversation; a fresh thread
  // shows the orb landing (the empty-state entry).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await conversationInit({ kind: "main" });
        if (cancelled) return;
        setSessionKey(r.sessionKey);
        if (r.existing) setView("conversation");
      } catch {
        // Transient — reopening the panel retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmitFromLanding = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBootstrap(trimmed);
    setView("conversation");
  }, []);

  return (
    <div className="relative h-full">
      {/* 桌面 focus-mode 开关 —— 浮在 ConversationView 自带 header 之上 */}
      <button
        onClick={onToggleExpand}
        className="absolute top-4 right-14 z-30 p-2 rounded-xl hover:bg-foreground/[0.06] text-foreground/45 hover:text-foreground/75 transition-colors"
        aria-label={expanded ? "Collapse panel" : "Expand panel"}
        title={expanded ? "Collapse" : "Expand"}
      >
        {expanded ? <Minimize2 size={15} strokeWidth={1.8} /> : <Maximize2 size={15} strokeWidth={1.8} />}
      </button>

      {sessionKey === null ? (
        <div className="absolute inset-0" aria-hidden />
      ) : (
        <>
          <div
            className="absolute inset-0"
            style={{ display: view === "landing" ? "block" : "none" }}
            aria-hidden={view !== "landing"}
          >
            <MinimalistLanding onBack={onClose} onSubmit={handleSubmitFromLanding} disabled={false} />
          </div>
          <div
            className="absolute inset-0"
            style={{ display: view === "conversation" ? "block" : "none" }}
            aria-hidden={view !== "conversation"}
          >
            <ConversationView
              session={sessionKey}
              bootstrap={bootstrap}
              onBack={onClose}
              backIcon="down"
              enableBrowserSplit
              onBrowserSplitChange={onBrowserSplitChange}
            />
          </div>
        </>
      )}
    </div>
  );
}
