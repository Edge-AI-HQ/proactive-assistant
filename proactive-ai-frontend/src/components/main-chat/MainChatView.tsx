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
  useMessage,
  useThreadRuntime,
} from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/store";
import "highlight.js/styles/github.css";
import { useProactiveChatRuntime } from "../chat/useProactiveChatRuntime";
import ToolActivityCard from "./ToolActivityCard";
import MessageActionBar from "./MessageActionBar";
import MarkdownContent from "./MarkdownContent";
import ReasoningBlock from "./ReasoningBlock";
import BrowserPanel from "../browser-view/BrowserPanel";
import type { SheetStage } from "../browser-view/BrowserView";
import { useBrowserSession } from "@/hooks/useBrowserSession";

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
              Reasoning: ReasoningBlock,
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
  const { session: browserSession, setControl, sendInput, refreshLiveView, close: closeBrowser } =
    useBrowserSession(sessionKey);

  // Reported by BrowserPanel on each snap so ChatRuntimeScope can leave
  // top padding for the mini drag bar. medium/full deliberately cover the
  // chat (that's the point of expanding), no offset there.
  const [browserStage, setBrowserStage] = useState<SheetStage | "closed">(
    "closed",
  );
  // Composer focus → BrowserPanel demotes full → medium so the typing area
  // isn't covered when the keyboard comes up.
  const [composerFocused, setComposerFocused] = useState(false);

  // When the app returns to the foreground, iOS may have paused the
  // Browserbase Live View's WebSocket AND its signed iframe URL may have
  // expired. We refresh the URL first so the remount loads a fresh token,
  // then bump the iframe key. NOT remounting ChatRuntimeScope —
  // that would drop the composer draft / in-flight streaming.
  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const lastReloadAtRef = useRef(0);

  useEffect(() => {
    const bump = () => {
      const now = Date.now();
      if (now - lastReloadAtRef.current < 1500) return;
      lastReloadAtRef.current = now;
      void (async () => {
        await refreshLiveView();
        setIframeReloadKey((k) => k + 1);
      })();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisibility);

    let capListener: { remove: () => Promise<void> } | null = null;
    void import("@capacitor/app").then(({ App }) =>
      App.addListener("appStateChange", (state) => {
        if (state.isActive) bump();
      }),
    ).then((l) => {
      capListener = l;
    }).catch(() => {});

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void capListener?.remove();
    };
  }, [refreshLiveView]);

  // BrowserPanel still operates in (mode, x, y, dx, dy) primitives — wrap
  // the hook's typed `sendInput` so the panel doesn't have to know about
  // the wire shape.
  const handleUserInputText = useCallback(
    (text: string) => sendInput({ type: "text", text }),
    [sendInput],
  );
  const handleUserInputKey = useCallback(
    (key: string) => sendInput({ type: "key", key }),
    [sendInput],
  );
  const handleUserInputClick = useCallback(
    (x: number, y: number) => sendInput({ type: "click", x, y }),
    [sendInput],
  );
  const handleUserInputScroll = useCallback(
    (dx: number, dy: number) => sendInput({ type: "scroll", dx, dy }),
    [sendInput],
  );
  const handleBrowserControlChange = useCallback(
    (mode: "ai" | "user") => {
      void setControl(mode);
    },
    [setControl],
  );
  const handleBrowserClose = useCallback(() => {
    void closeBrowser();
  }, [closeBrowser]);

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
          session={
            browserSession
              ? {
                  browserSessionId: browserSession.sessionKey,
                  liveViewUrl: browserSession.liveViewUrl,
                  viewport: browserSession.viewport,
                  currentUrl: browserSession.currentUrl,
                  controlMode: browserSession.controlMode,
                  takeoverReason: browserSession.takeoverReason,
                }
              : null
          }
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

          <ChatComposer
            inputPlaceholder={inputPlaceholder}
            kbVisible={kbVisible}
            onDismissKeyboard={handleDismissKeyboard}
            onComposerFocusChange={onComposerFocusChange}
          />
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}

/**
 * Composer with a plain controlled <textarea>. We deliberately avoid
 * assistant-ui's `ComposerPrimitive.Input` here: its internal value
 * binding goes through useAuiState(s.composer.text) which can race with
 * the message-list-scope re-render after each turn (typed chars get
 * eaten as `value` snaps back to "").
 *
 * Local React state owns the textarea value end-to-end; on submit we
 * call `threadRuntime.append({...})` which adds the user message and
 * triggers the run, identical to what ComposerPrimitive.Send would do.
 * `isRunning` from useAuiState gates the submit button.
 */
function ChatComposer({
  inputPlaceholder,
  kbVisible,
  onDismissKeyboard,
  onComposerFocusChange,
}: {
  inputPlaceholder?: string;
  kbVisible: boolean;
  onDismissKeyboard: () => void;
  onComposerFocusChange: (focused: boolean) => void;
}) {
  const threadRuntime = useThreadRuntime();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow up to ~6 rows (~128px) — matches the max-h-32 ceiling on
  // the previous TextareaAutosize. Recompute on every change.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  }, [text]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;
    setText("");
    await threadRuntime.append({
      role: "user",
      content: [{ type: "text", text: trimmed }],
    });
  }, [text, isRunning, threadRuntime]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // IME compose
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      className="shrink-0 px-3 pb-3 pt-2"
      style={{
        background: "hsla(0, 0%, 100%, 0.35)",
        borderTop: "1px solid hsla(0, 0%, 100%, 0.3)",
      }}
    >
      <div
        className="glass-card-strong flex items-end gap-1 px-4 py-2 rounded-2xl"
        onFocusCapture={() => onComposerFocusChange(true)}
        onBlurCapture={() => onComposerFocusChange(false)}
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={inputPlaceholder ?? "Type a message..."}
          rows={1}
          className="flex-1 bg-transparent text-[16px] text-foreground placeholder:text-foreground/35 outline-none resize-none max-h-32 py-1"
        />
        {kbVisible && (
          <button
            type="button"
            // preventDefault so click doesn't blur the textarea before
            // our handler runs.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDismissKeyboard}
            className="p-2 rounded-xl transition-colors hover:bg-foreground/10 text-foreground/50"
            title="Dismiss keyboard"
          >
            <ChevronDown size={18} strokeWidth={1.8} />
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!text.trim() || isRunning}
          className="p-2 rounded-xl transition-colors disabled:opacity-30 hover:bg-foreground/10"
          aria-label="Send"
        >
          <Send size={18} strokeWidth={1.8} className="text-foreground/60" />
        </button>
      </div>
    </div>
  );
}
