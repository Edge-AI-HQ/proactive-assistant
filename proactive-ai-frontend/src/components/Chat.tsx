/**
 * Unified streaming chat component built on assistant-ui primitives.
 *
 * All chat UIs (MainChat, CardChat) use this component. Communication:
 *   1. Chat: POST /chat-stream/send returns SSE stream with chat:thinking/reply/error
 *   2. Browser: GET /browser/events returns SSE stream with browser:opened/closed/control
 */
import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Send, Loader2, ChevronDown } from "lucide-react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
} from "@assistant-ui/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useProactiveChatRuntime } from "./chat/useProactiveChatRuntime";
import ToolStepCard from "./chat/ToolStepCard";
import { proxyFetch, proxyPost } from "@/lib/api";
import BrowserPanel from "./browser-view/BrowserPanel";

interface BrowserSession {
  browserSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  controlMode: "ai" | "user" | "idle";
}

interface ChatProps {
  sessionKey: string;
  title: string;
  subtitle?: string;
  onBack: () => void;
  headerSlot?: ReactNode;
  emptyMessage?: string;
  inputPlaceholder?: string;
  cardContext?: Record<string, unknown>;
}

// ── SSE line parser for browser events ──
function parseSSELines(
  buffer: string,
  onEvent: (data: Record<string, unknown>) => void,
): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
    } catch { /* skip non-JSON */ }
  }
  return remainder;
}

// ── Custom message components ──

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end mb-3">
      <div className="max-w-[85%] px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap bg-foreground text-background rounded-2xl rounded-br-md">
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start mb-3 group">
      <div className="max-w-[85%] px-4 py-3 text-[14px] leading-relaxed glass-card-strong rounded-2xl rounded-bl-md text-foreground/80">
        <MessagePrimitive.Content
          components={{
            Text: MarkdownText,
            tools: { Fallback: ToolStepCard },
          }}
        />
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="not-last"
          className="mt-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <ActionBarPrimitive.Copy className="text-[11px] text-foreground/40 hover:text-foreground/70 px-1.5 py-0.5 rounded transition-colors">
            Copy
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

function MarkdownText({ text }: { text: string; [key: string]: unknown }) {
  return (
    <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-pre:my-2 prose-code:text-[13px] prose-code:bg-foreground/5 prose-code:px-1 prose-code:py-0.5 prose-code:rounded">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default function Chat({
  sessionKey,
  title,
  subtitle,
  onBack,
  headerSlot,
  emptyMessage = "Send a message to start chatting",
  inputPlaceholder,
  cardContext,
}: ChatProps) {
  const { runtime, historyLoaded } = useProactiveChatRuntime({
    sessionKey,
    cardContext,
  });

  // Browser SSE state
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const browserSseRef = useRef<AbortController | null>(null);

  // Connect browser SSE channel
  useEffect(() => {
    const controller = new AbortController();
    browserSseRef.current = controller;

    (async () => {
      try {
        const res = await proxyFetch(
          `/browser/events?sessionKey=${encodeURIComponent(sessionKey)}`,
          { signal: controller.signal },
        );
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          buffer = parseSSELines(buffer, (data) => {
            const type = data.type as string | undefined;
            if (type === "browser:opened") {
              setBrowserSession({
                browserSessionId: data.browserSessionId as string,
                liveViewUrl: data.liveViewUrl as string,
                viewport: (data.viewport as { width: number; height: number }) ?? { width: 390, height: 844 },
                controlMode: "ai",
              });
            } else if (type === "browser:closed") {
              setBrowserSession(null);
            } else if (type === "browser:control") {
              setBrowserSession((prev) =>
                prev ? { ...prev, controlMode: data.mode as "ai" | "user" } : null,
              );
            }
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.warn("[Chat] Browser SSE error:", err);
        }
      }
    })();

    return () => controller.abort();
  }, [sessionKey]);

  const handleBrowserControlChange = useCallback((mode: "ai" | "user") => {
    setBrowserSession((prev) => prev ? { ...prev, controlMode: mode } : null);
    if (browserSession) {
      void proxyPost(`/browser/sessions/${browserSession.browserSessionId}/control`, { mode });
    }
  }, [browserSession]);

  const handleBrowserClose = useCallback(() => {
    if (browserSession) {
      void proxyFetch(`/browser/sessions/${browserSession.browserSessionId}`, { method: "DELETE" });
      setBrowserSession(null);
    }
  }, [browserSession]);

  return (
    <motion.div
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 30, stiffness: 300 }}
      className="absolute inset-0 z-50 flex flex-col"
      style={{
        background: "hsla(220, 30%, 96%, 0.95)",
        backdropFilter: "blur(60px) saturate(1.4)",
        WebkitBackdropFilter: "blur(60px) saturate(1.4)",
      }}
    >
      {/* Header */}
      <div
        className="shrink-0 px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3"
        style={{
          background: "hsla(0, 0%, 100%, 0.5)",
          borderBottom: "1px solid hsla(0, 0%, 100%, 0.4)",
          backdropFilter: "blur(40px)",
          WebkitBackdropFilter: "blur(40px)",
        }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 -ml-1 rounded-xl hover:bg-foreground/10 transition-colors"
          >
            <ArrowLeft size={20} strokeWidth={1.8} className="text-foreground/70" />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-display text-[15px] text-foreground truncate">{title}</h2>
            <p className="text-[11px] text-foreground/40">{subtitle ?? emptyMessage}</p>
          </div>
        </div>
      </div>

      {headerSlot}

      {/* assistant-ui powered chat */}
      {!historyLoaded ? (
        <div className="flex-1 flex justify-center items-center">
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin text-foreground/40" />
            <span className="text-[13px] text-foreground/40">Loading conversation...</span>
          </div>
        </div>
      ) : (
        <AssistantRuntimeProvider runtime={runtime}>
          <div
            className="flex flex-col overflow-hidden transition-all duration-300"
            style={{ flex: browserExpanded ? "0 0 40%" : "1 1 0%" }}
          >
            <ThreadPrimitive.Root className="flex-1 flex flex-col overflow-hidden">
              {/* Messages viewport */}
              <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-3">
                <ThreadPrimitive.Empty>
                  <div className="flex justify-center py-12">
                    <p className="text-[13px] text-foreground/30">{emptyMessage}</p>
                  </div>
                </ThreadPrimitive.Empty>

                <ThreadPrimitive.Messages
                  components={{
                    UserMessage,
                    AssistantMessage,
                  }}
                />

                <ThreadPrimitive.ViewportFooter />
              </ThreadPrimitive.Viewport>

              {/* Scroll to bottom button */}
              <ThreadPrimitive.ScrollToBottom className="absolute bottom-24 right-4 z-10 p-2 rounded-full glass-card-strong shadow-md hover:bg-foreground/10 transition-colors">
                <ChevronDown size={16} className="text-foreground/60" />
              </ThreadPrimitive.ScrollToBottom>

              {/* Composer (input bar) */}
              <div
                className="shrink-0 px-3 pb-3 pt-2"
                style={{
                  background: "hsla(0, 0%, 100%, 0.35)",
                  borderTop: "1px solid hsla(0, 0%, 100%, 0.3)",
                }}
              >
                <ComposerPrimitive.Root className="glass-card-strong flex items-center gap-2 px-4 py-2 rounded-2xl">
                  <ComposerPrimitive.Input
                    placeholder={inputPlaceholder ?? "Type a message..."}
                    className="flex-1 bg-transparent text-[14px] text-foreground placeholder:text-foreground/35 outline-none resize-none max-h-32"
                    autoFocus
                  />
                  <ComposerPrimitive.Send className="p-2 rounded-xl transition-colors disabled:opacity-30 hover:bg-foreground/10">
                    <Send size={18} strokeWidth={1.8} className="text-foreground/60" />
                  </ComposerPrimitive.Send>
                </ComposerPrimitive.Root>
              </div>
            </ThreadPrimitive.Root>
          </div>
        </AssistantRuntimeProvider>
      )}

      {/* Browser panel */}
      <BrowserPanel
        session={browserSession}
        onControlChange={handleBrowserControlChange}
        onClose={handleBrowserClose}
        onExpandedChange={setBrowserExpanded}
      />
    </motion.div>
  );
}
