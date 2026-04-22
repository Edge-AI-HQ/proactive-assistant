/**
 * Claude-style streaming chat view for Main Chat.
 *
 * Structure mirrors Chat.tsx (header / thread / composer / browser panel)
 * but messages, tool-activity, and action bar are restyled to match a more
 * mature assistant product (Claude.ai / Claude Code).
 *
 * Shares data-layer with Chat.tsx via useProactiveChatRuntime and tool-steps.
 * Kept as a separate component so Chat.tsx / CardChat keep working untouched;
 * once MainChatView is validated, CardChat can migrate in a single line.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Send, Loader2, ChevronDown, Sparkles } from "lucide-react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  useMessage,
  useThreadRuntime,
} from "@assistant-ui/react";
import "highlight.js/styles/github.css";
import { useProactiveChatRuntime } from "../chat/useProactiveChatRuntime";
import ToolActivityCard from "./ToolActivityCard";
import MessageActionBar from "./MessageActionBar";
import MarkdownContent from "./MarkdownContent";
import BrowserPanel from "../browser-view/BrowserPanel";
import { proxyFetch, proxyPost } from "@/lib/api";

interface BrowserSession {
  browserSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  controlMode: "ai" | "user" | "idle";
}

interface MainChatViewProps {
  sessionKey: string;
  title: string;
  subtitle?: string;
  onBack: () => void;
  headerSlot?: ReactNode;
  emptyMessage?: string;
  inputPlaceholder?: string;
  cardContext?: Record<string, unknown>;
  /**
   * Rendered inside `<ThreadPrimitive.Empty>`. Defaults to the profile-
   * building prompt cards used by Main Chat. Card-context surfaces pass
   * `null` (the agent sends the first message, so the empty slot is
   * transient and doesn't need suggestions).
   */
  emptyState?: ReactNode;
}

const DEFAULT_PROFILE_PROMPTS: readonly string[] = [
  "Tell me about your typical weekday — when you start, work, wind down.",
  "What are you working on right now?",
  "What apps and tools do you live inside?",
  "What's something new you want to try or learn this month?",
];

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
    } catch {
      /* skip non-JSON */
    }
  }
  return remainder;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root asChild>
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="mb-4 flex flex-col items-end"
      >
        <div className="max-w-[82%] px-4 py-2.5 text-[17px] leading-relaxed whitespace-pre-wrap bg-foreground/90 text-background rounded-2xl rounded-br-md">
          <MessagePrimitive.Content />
        </div>
        <MessageActionBar variant="user" />
      </motion.div>
    </MessagePrimitive.Root>
  );
}

function ThinkingIndicator() {
  const isRunning = useMessage((m) => m.status?.type === "running");
  const hasContent = useMessage((m) =>
    m.content.some((part) => {
      if (part.type === "text") return Boolean(part.text);
      return true;
    }),
  );
  if (!isRunning || hasContent) return null;
  return (
    <div className="flex items-center gap-1.5 py-1 text-foreground/40">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-foreground/40 animate-pulse [animation-delay:-0.3s]" />
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-foreground/40 animate-pulse [animation-delay:-0.15s]" />
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-foreground/40 animate-pulse" />
      <span className="ml-1 text-[12px]">Thinking…</span>
    </div>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root asChild>
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="mb-5"
      >
        <div className="px-1 text-[17px] leading-[1.55] text-foreground/85">
          <ThinkingIndicator />
          <MessagePrimitive.Content
            components={{
              Text: MarkdownContent,
              tools: { Fallback: ToolActivityCard },
            }}
          />
          <MessageActionBar variant="assistant" />
        </div>
      </motion.div>
    </MessagePrimitive.Root>
  );
}

function SuggestionCard({ text, onSelect }: { text: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group text-left w-full rounded-2xl border border-foreground/10 bg-white/40 hover:bg-white/60 active:bg-white/70 backdrop-blur-sm transition-colors px-3.5 py-3"
    >
      <div className="flex items-start gap-2">
        <Sparkles
          size={14}
          strokeWidth={1.8}
          className="mt-0.5 text-foreground/40 group-hover:text-foreground/60 shrink-0"
        />
        <span className="text-[13.5px] leading-snug text-foreground/75">{text}</span>
      </div>
    </button>
  );
}

function EmptyState({ prompts, title }: { prompts: readonly string[]; title: string }) {
  const runtime = useThreadRuntime();
  const send = (text: string) => {
    runtime.append({ role: "user", content: [{ type: "text", text }] });
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="max-w-lg mx-auto py-10 px-4"
    >
      <div className="text-center mb-5">
        <h3 className="text-display text-[18px] text-foreground/80 mb-1">
          {title}
        </h3>
        <p className="text-[13px] text-foreground/45">
          Share a bit about yourself so I can help more precisely.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {prompts.map((p) => (
          <SuggestionCard key={p} text={p} onSelect={() => send(p)} />
        ))}
      </div>
    </motion.div>
  );
}

export default function MainChatView({
  sessionKey,
  title,
  subtitle,
  onBack,
  headerSlot,
  emptyMessage = "Send a message to start chatting",
  inputPlaceholder,
  cardContext,
  emptyState,
}: MainChatViewProps) {
  const { runtime, historyLoaded } = useProactiveChatRuntime({
    sessionKey,
    cardContext,
  });

  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(
    null,
  );
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const browserSseRef = useRef<AbortController | null>(null);

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
                viewport:
                  (data.viewport as { width: number; height: number }) ?? {
                    width: 390,
                    height: 844,
                  },
                controlMode: "ai",
              });
            } else if (type === "browser:closed") {
              setBrowserSession(null);
            } else if (type === "browser:control") {
              setBrowserSession((prev) =>
                prev
                  ? { ...prev, controlMode: data.mode as "ai" | "user" }
                  : null,
              );
            }
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.warn("[MainChatView] Browser SSE error:", err);
        }
      }
    })();

    return () => controller.abort();
  }, [sessionKey]);

  const handleBrowserControlChange = useCallback(
    (mode: "ai" | "user") => {
      setBrowserSession((prev) =>
        prev ? { ...prev, controlMode: mode } : null,
      );
      if (browserSession) {
        void proxyPost(
          `/browser/sessions/${browserSession.browserSessionId}/control`,
          { mode },
        );
      }
    },
    [browserSession],
  );

  const handleBrowserClose = useCallback(() => {
    if (browserSession) {
      void proxyFetch(`/browser/sessions/${browserSession.browserSessionId}`, {
        method: "DELETE",
      });
      setBrowserSession(null);
    }
  }, [browserSession]);

  return (
    <motion.div
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 30, stiffness: 300 }}
      className="absolute inset-0 z-50 flex flex-col font-native"
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
            <ArrowLeft
              size={20}
              strokeWidth={1.8}
              className="text-foreground/70"
            />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-display text-[15px] text-foreground truncate">
              {title}
            </h2>
            <p className="text-[11px] text-foreground/40">
              {subtitle ?? emptyMessage}
            </p>
          </div>
        </div>
      </div>

      {headerSlot}

      {!historyLoaded ? (
        <div className="flex-1 flex justify-center items-center">
          <div className="flex items-center gap-2">
            <Loader2 size={14} className="animate-spin text-foreground/40" />
            <span className="text-[13px] text-foreground/40">
              Loading conversation...
            </span>
          </div>
        </div>
      ) : (
        <AssistantRuntimeProvider runtime={runtime}>
          <div
            className="flex flex-col overflow-hidden transition-all duration-300"
            style={{ flex: browserExpanded ? "0 0 40%" : "1 1 0%" }}
          >
            <ThreadPrimitive.Root className="flex-1 flex flex-col overflow-hidden">
              <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-4">
                <ThreadPrimitive.Empty>
                  {emptyState !== undefined ? (
                    emptyState
                  ) : (
                    <EmptyState
                      prompts={DEFAULT_PROFILE_PROMPTS}
                      title="What's on your mind?"
                    />
                  )}
                </ThreadPrimitive.Empty>

                <ThreadPrimitive.Messages
                  components={{
                    UserMessage,
                    AssistantMessage,
                  }}
                />

                <ThreadPrimitive.ViewportFooter />
              </ThreadPrimitive.Viewport>

              <ThreadPrimitive.ScrollToBottom className="absolute bottom-24 right-4 z-10 p-2 rounded-full glass-card-strong shadow-md hover:bg-foreground/10 transition-colors">
                <ChevronDown size={16} className="text-foreground/60" />
              </ThreadPrimitive.ScrollToBottom>

              <div
                className="shrink-0 px-3 pb-3 pt-2"
                style={{
                  background: "hsla(0, 0%, 100%, 0.35)",
                  borderTop: "1px solid hsla(0, 0%, 100%, 0.3)",
                }}
              >
                <ComposerPrimitive.Root className="glass-card-strong flex items-end gap-2 px-4 py-2 rounded-2xl">
                  <ComposerPrimitive.Input
                    placeholder={inputPlaceholder ?? "Type a message..."}
                    className="flex-1 bg-transparent text-[16px] text-foreground placeholder:text-foreground/35 outline-none resize-none max-h-32 py-1"
                    autoFocus
                    rows={1}
                  />
                  <ComposerPrimitive.Send className="p-2 rounded-xl transition-colors disabled:opacity-30 hover:bg-foreground/10">
                    <Send
                      size={18}
                      strokeWidth={1.8}
                      className="text-foreground/60"
                    />
                  </ComposerPrimitive.Send>
                </ComposerPrimitive.Root>
              </div>
            </ThreadPrimitive.Root>
          </div>
        </AssistantRuntimeProvider>
      )}

      <BrowserPanel
        session={browserSession}
        onControlChange={handleBrowserControlChange}
        onClose={handleBrowserClose}
        onExpandedChange={setBrowserExpanded}
      />
    </motion.div>
  );
}
