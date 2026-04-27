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
import type { SheetStage } from "../browser-view/BrowserView";
import { proxyFetch, proxyPost } from "@/lib/api";
import { isNative } from "@/lib/platform";

interface BrowserSession {
  browserSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  /** Last-known remote page URL — drives the URL bar in the panel header. */
  currentUrl: string;
  controlMode: "ai" | "user" | "idle";
  /**
   * Set when the AI asks the user to take over (e.g. captcha / 2FA).
   * Cleared when control returns to AI. Plain user-initiated "Take
   * Control" clicks do not set this — it's specifically the AI-requested
   * handoff overlay.
   */
  takeoverReason?: string | null;
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

function parseControlMode(value: unknown): BrowserSession["controlMode"] {
  return value === "user" || value === "idle" ? value : "ai";
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
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(
    null,
  );
  // Reported by BrowserPanel on each snap so ChatRuntimeScope can leave
  // top padding for the mini drag bar. medium/full deliberately cover the
  // chat (that's the point of expanding), no offset there.
  const [browserStage, setBrowserStage] = useState<SheetStage | "closed">(
    "closed",
  );
  // Composer focus → BrowserPanel demotes full → medium so the typing area
  // isn't covered when the keyboard comes up.
  const [composerFocused, setComposerFocused] = useState(false);
  const browserSseRef = useRef<AbortController | null>(null);

  // When the app returns to the foreground, iOS may have paused the
  // Browserbase Live View's WebSocket and left the iframe blank. Bump a
  // key on the iframe to force a clean reload. We intentionally do NOT
  // remount ChatRuntimeScope — doing that destroys the composer's draft
  // and any in-flight streaming state. History refresh on foreground is
  // a separate, opt-in gesture we'll wire to a pull-to-refresh later.
  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const lastReloadAtRef = useRef(0);

  useEffect(() => {
    const bump = () => {
      const now = Date.now();
      if (now - lastReloadAtRef.current < 1500) return;
      lastReloadAtRef.current = now;
      setIframeReloadKey((k) => k + 1);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let capListener: { remove: () => Promise<void> } | null = null;
    if (isNative) {
      void import("@capacitor/app").then(({ App }) =>
        App.addListener("appStateChange", (state) => {
          if (state.isActive) bump();
        }),
      ).then((l) => {
        capListener = l;
      }).catch(() => {});
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void capListener?.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let activeController: AbortController | null = null;

    const handleEvent = (data: Record<string, unknown>) => {
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
          currentUrl: typeof data.url === "string" ? data.url : "",
          controlMode: parseControlMode(data.controlMode),
          takeoverReason:
            typeof data.takeoverReason === "string"
              ? data.takeoverReason
              : null,
        });
      } else if (type === "browser:closed") {
        setBrowserSession(null);
      } else if (type === "browser:navigated") {
        const nextUrl = typeof data.url === "string" ? data.url : "";
        setBrowserSession((prev) =>
          prev ? { ...prev, currentUrl: nextUrl } : null,
        );
      } else if (type === "browser:control") {
        const nextMode = parseControlMode(data.mode);
        const reason =
          typeof data.reason === "string" && data.reason
            ? data.reason
            : null;
        setBrowserSession((prev) =>
          prev
            ? {
                ...prev,
                controlMode: nextMode,
                takeoverReason:
                  nextMode === "ai" ? null : reason ?? prev.takeoverReason,
              }
            : null,
        );
      } else if (type === "browser:takeover-requested") {
        const reason =
          typeof data.reason === "string" && data.reason
            ? data.reason
            : "AI needs your help";
        setBrowserSession((prev) =>
          prev
            ? { ...prev, controlMode: "user", takeoverReason: reason }
            : null,
        );
      }
    };

    // Auto-reconnect loop. Some proxy layer (gateway / fly.io / Cloudflare)
    // closes this SSE after ~20s idle even though the backend heartbeats
    // every 15s; agents also open browsers long after the initial stream
    // ended. Without reconnect we'd miss every browser:opened that fires
    // past the first connection. Backend replays the current active session
    // state on each new connection (routes/browser.ts getActiveSession),
    // so reconnecting is safe and catches us up on anything we missed.
    const connectLoop = async () => {
      while (!cancelled) {
        const controller = new AbortController();
        activeController = controller;
        browserSseRef.current = controller;

        try {
          const res = await proxyFetch(
            `/browser/events?sessionKey=${encodeURIComponent(sessionKey)}`,
            { signal: controller.signal },
          );
          if (!res.ok || !res.body) {
            throw new Error(`SSE request failed: ${res.status}`);
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSSELines(buffer, handleEvent);
          }
        } catch (err) {
          if (controller.signal.aborted || cancelled) return;
          console.warn("[MainChatView] Browser SSE dropped, reconnecting:", err);
        }

        if (cancelled) return;
        // Small backoff so transient failures don't hot-loop.
        await new Promise((r) => setTimeout(r, 1500));
      }
    };

    void connectLoop();

    return () => {
      cancelled = true;
      activeController?.abort();
    };
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

  // /input callbacks share the same stale-session handling: if the backend
  // says the session is gone (404) we drop the local reference so the
  // panel unmounts instead of letting the user keep firing dead POSTs.
  // Any other non-2xx is logged but not propagated — keeps UX quiet while
  // still surfacing in devtools if needed.
  const postInput = useCallback(
    async (body: Record<string, unknown>) => {
      if (!browserSession) return;
      const res = await proxyPost(
        `/browser/sessions/${browserSession.browserSessionId}/input`,
        body,
      );
      if (res.ok) return;
      if (res.status === 404) {
        console.warn("[MainChatView] /input 404 — session gone, clearing local state");
        setBrowserSession(null);
        return;
      }
      console.warn("[MainChatView] /input non-ok", res.status);
    },
    [browserSession],
  );

  const handleUserInputText = useCallback(
    (text: string) => postInput({ type: "text", text }),
    [postInput],
  );
  const handleUserInputKey = useCallback(
    (key: string) => postInput({ type: "key", key }),
    [postInput],
  );
  // Tap → click and pan → scroll, both forwarded as remote-viewport coords
  // (the BrowserView has already inverted its CSS transform scale before
  // posting). Browserbase's iframe doesn't pass these through inside iOS
  // WKWebView when sandboxed and cross-origin.
  const handleUserInputClick = useCallback(
    (x: number, y: number) => postInput({ type: "click", x, y }),
    [postInput],
  );
  const handleUserInputScroll = useCallback(
    (dx: number, dy: number) => postInput({ type: "scroll", dx, dy }),
    [postInput],
  );

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
        // 键盘响应由 ChatRuntimeScope 内部的 padding-bottom 处理
        // （不再上移整块 MainChatView），这样 BrowserPanel 贴 header
        // 下沿的位置不受键盘影响，不会被挤出屏幕顶部。
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

      {/* Panel wraps the chat runtime in a `relative` container so the
          top-sheet BrowserPanel can be `absolute top-0` relative to this
          region — it slides down from just below the header, never
          covering the back button / title. When peek is active, the
          sheet occupies the top 56px; we pad the chat so messages aren't
          clipped behind it. */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <ChatRuntimeScope
          sessionKey={sessionKey}
          cardContext={cardContext}
          topOffset={browserStage === "mini" ? 32 : 0}
          emptyState={emptyState}
          inputPlaceholder={inputPlaceholder}
          onComposerFocusChange={setComposerFocused}
        />

        <BrowserPanel
          session={browserSession}
          iframeReloadKey={iframeReloadKey}
          onControlChange={handleBrowserControlChange}
          onUserInputText={handleUserInputText}
          onUserInputKey={handleUserInputKey}
          onUserInputClick={handleUserInputClick}
          onUserInputScroll={handleUserInputScroll}
          onClose={handleBrowserClose}
          onStageChange={setBrowserStage}
          composerFocused={composerFocused}
        />
      </div>
    </motion.div>
  );
}

/**
 * Holds the useProactiveChatRuntime call + assistant-ui thread JSX.
 *
 * Extracted so MainChatView can force a remount via `key={refreshKey}` when
 * the user returns to the foreground — this re-fetches history and catches
 * any writes that happened while the view was hidden (e.g. another client,
 * a background job, or a run that finished after the first mount sampled
 * partial history). Everything outside this scope (header, browser panel,
 * SSE subscriptions) stays mounted across refreshes.
 */
function ChatRuntimeScope({
  sessionKey,
  cardContext,
  topOffset,
  emptyState,
  inputPlaceholder,
  onComposerFocusChange,
}: {
  sessionKey: string;
  cardContext?: Record<string, unknown>;
  /** px of top padding so messages aren't clipped behind the mini drag bar. */
  topOffset: number;
  emptyState?: ReactNode;
  inputPlaceholder?: string;
  onComposerFocusChange: (focused: boolean) => void;
}) {
  // Track keyboard so we can render a dismiss-keyboard button in the
  // composer. Listens to the global events dispatched from main.tsx when
  // Capacitor Keyboard fires willShow / willHide.
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const show = () => setKbVisible(true);
    const hide = () => setKbVisible(false);
    window.addEventListener("pinai:kbShow", show);
    window.addEventListener("pinai:kbHide", hide);
    return () => {
      window.removeEventListener("pinai:kbShow", show);
      window.removeEventListener("pinai:kbHide", hide);
    };
  }, []);

  const handleDismissKeyboard = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    active?.blur?.();
  }, []);
  const { runtime, historyLoaded } = useProactiveChatRuntime({
    sessionKey,
    cardContext,
  });

  if (!historyLoaded) {
    return (
      <div className="flex-1 flex justify-center items-center">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-foreground/40" />
          <span className="text-[13px] text-foreground/40">
            Loading conversation...
          </span>
        </div>
      </div>
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div
        className="flex-1 flex flex-col overflow-hidden"
        style={{
          paddingTop: topOffset,
          // Keyboard makes room for itself here (not on the outer
          // MainChatView) so BrowserPanel — which is a sibling absolute
          // child of the chat — isn't pushed off-screen by the keyboard.
          paddingBottom: "var(--kb-height, 0px)",
          transition:
            "padding-top 200ms ease-out, padding-bottom 250ms cubic-bezier(0.17, 0.59, 0.4, 0.77)",
        }}
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
            <ComposerPrimitive.Root
              className="glass-card-strong flex items-end gap-1 px-4 py-2 rounded-2xl"
              onFocusCapture={() => onComposerFocusChange(true)}
              onBlurCapture={() => onComposerFocusChange(false)}
            >
              <ComposerPrimitive.Input
                placeholder={inputPlaceholder ?? "Type a message..."}
                className="flex-1 bg-transparent text-[16px] text-foreground placeholder:text-foreground/35 outline-none resize-none max-h-32 py-1"
                rows={1}
              />
              {kbVisible && (
                <button
                  type="button"
                  // onMouseDown preventDefault so the composer input doesn't
                  // lose focus before our click handler runs — we need the
                  // focused element to blur explicitly on click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleDismissKeyboard}
                  className="p-2 rounded-xl transition-colors hover:bg-foreground/10 text-foreground/50"
                  title="Dismiss keyboard"
                >
                  <ChevronDown size={18} strokeWidth={1.8} />
                </button>
              )}
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
  );
}
