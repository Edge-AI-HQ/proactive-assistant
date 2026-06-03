/**
 * Claude-style streaming chat view.
 *
 * Renders a single thread's transcript + composer + browser panel using an
 * assistant-ui runtime supplied by the parent (MainChat lifts the singleton
 * main-thread runtime; CardChat instantiates its own per-card runtime).
 *
 * Header chrome adapts: when `title` is supplied (CardChat path) it draws a
 * glass header bar; otherwise it falls back to the minimalist design — just
 * a ChevronDown back-affordance in the top-left, matching the reference
 * MinimalistConversation visual. Pull-down at the top of the viewport
 * dismisses the conversation (back to Landing) on touch devices.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ChevronDown, Loader2, Send } from "lucide-react";
import bgGradient from "@/assets/bg-gradient.jpg";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  useMessage,
  useMessageRuntime,
  useThreadRuntime,
  type AssistantRuntime,
} from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/store";
import "highlight.js/styles/github.css";
import ChatToolGroup, { type ChatToolGroupItem } from "./ChatToolGroup";
import ProposeActionCard from "./ProposeActionCard";
import MessageActionBar from "./MessageActionBar";
import { EditableUserMessageComposer } from "./EditableUserMessageComposer";
import MarkdownContent from "./MarkdownContent";
import ReasoningBlock, { ShimmerText } from "./ReasoningBlock";
import TodoPanel from "./TodoPanel";
import BrowserPanel from "../browser-view/BrowserPanel";
import type { SheetStage } from "../browser-view/BrowserView";
import { useBrowserSession } from "@/hooks/useBrowserSession";
import { VoiceButton } from "@/components/voice";

interface MainChatViewProps {
  sessionKey: string;
  /** assistant-ui runtime supplied by parent (MainChat / CardChat). The
   *  parent owns runtime lifecycle so multiple views over the same thread
   *  (Landing + Conversation) share one runtime and one in-flight SSE. */
  runtime: AssistantRuntime;
  /** True once the parent's history fetch has resolved. Gates the
   *  composer + message rendering so a half-mounted thread doesn't
   *  flash an empty state mid-load. */
  historyLoaded: boolean;
  onBack: () => void;
  /** When set, renders the full glass header with title + subtitle.
   *  Omit (main chat path) for the minimalist design — only a
   *  ChevronDown back button, no thread label. */
  title?: string;
  subtitle?: string;
  /** Extra header content rendered below the title bar (e.g. CardChat's
   *  goal-basket strip). */
  headerSlot?: ReactNode;
  emptyMessage?: string;
  inputPlaceholder?: string;
  /** Content for the empty-thread state. Default is `null` (no empty
   *  state UI) since the user only enters the conversation by sending a
   *  message — Landing handles the "nothing to show" affordance for
   *  main chat. CardChat passes `null` for the same reason (the agent
   *  bootstrap fills the first turn). */
  emptyState?: ReactNode;
  /** Card chat v1 should read `propose_action` as a normal assistant
   *  message instead of rendering draft cards / quick-reply chips. Main
   *  chat leaves this false, preserving the existing behavior. */
  renderProposeActionAsText?: boolean;
}

const ChatRenderOptionsContext = createContext({
  renderProposeActionAsText: false,
});

function useChatRenderOptions() {
  return useContext(ChatRenderOptionsContext);
}

function proposeActionTextFromArgs(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const inner = root.input && typeof root.input === "object"
    ? (root.input as Record<string, unknown>)
    : root;
  const text = typeof inner.message === "string" ? inner.message.trim() : "";
  return text || null;
}


/** Id of the first user message in the thread (or null). Used to hide the
 *  card-chat lead bubble — the pre-executed primaryAction. */
function useFirstUserMessageId(): string | null {
  return useAuiState((s) => {
    const msgs = s.thread.messages;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "user") return msgs[i].id;
    }
    return null;
  });
}

function UserMessage() {
  const { renderProposeActionAsText } = useChatRenderOptions();
  const messageId = useMessage((m) => m.id);
  const firstUserId = useFirstUserMessageId();
  // Card chat (renderProposeActionAsText=true) opens on a PRE-EXECUTED thread
  // whose first user turn IS the card's primaryAction — already shown verbatim
  // in the CONTEXT header. Hide just that one bubble so the card chat reads as
  // "agent reply", not a duplicate of the header. The message still exists in
  // the runtime (so the assistant reply's Regenerate, which targets this user
  // id as parent, keeps working). Main chat leaves the flag false → its first
  // user turn (what the user actually typed) renders normally.
  if (renderProposeActionAsText && messageId === firstUserId) return null;

  return (
    <MessagePrimitive.Root asChild>
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="mb-4 flex flex-col items-end"
      >
        <div className="max-w-[82%] px-4 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap bg-foreground/90 text-background rounded-2xl rounded-br-md">
          <MessagePrimitive.Content />
        </div>
        <MessageActionBar variant="user" />
      </motion.div>
    </MessagePrimitive.Root>
  );
}

/**
 * Inline edit composer rendered in place of `UserMessage` when the user
 * clicks the pencil icon on their last message (via
 * `ActionBarPrimitive.Edit` → assistant-ui's `beginEdit`).
 *
 * Visually keeps the dark user-bubble look. Save commits the edit:
 * assistant-ui drops the trailing assistant + tools, switches the
 * runtime state to the new text on the same user msg, then re-invokes
 * our adapter. The adapter sees `messages.length` unchanged (the
 * placeholder for the new assistant slot fills the dropped slot) and
 * passes `regenerate=true` to the backend; the backend diffs `message`
 * against LangGraph's trailing HumanMessage and replaces it with the
 * edited text before rerunning.
 */
function UserEditComposer() {
  const messageRuntime = useMessageRuntime();
  const composerText = useAuiState((s) => s.composer.text);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const initialTextRef = useRef(composerText);
  const editComposer = messageRuntime.composer;

  const handleDraftChange = useCallback(
    (draft: string) => {
      editComposer.setText(draft);
    },
    [editComposer],
  );

  const handleCancel = useCallback(() => {
    editComposer.cancel();
  }, [editComposer]);

  const handleSend = useCallback(
    (draft: string) => {
      editComposer.setText(draft);
      editComposer.send();
    },
    [editComposer],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="mb-4 flex flex-col items-end"
    >
      <EditableUserMessageComposer
        initialText={initialTextRef.current}
        disabled={isRunning}
        onDraftChange={handleDraftChange}
        onCancel={handleCancel}
        onSend={handleSend}
      />
    </motion.div>
  );
}

/**
 * Shown only in the very-first-token-pending window: the assistant turn
 * is running but no reasoning / text / tool part has streamed yet.
 *
 * Visually matches ReasoningBlock's collapsed "Thinking…" pill so the
 * transition from "no parts yet" → "reasoning streaming" → "Thought for Xs"
 * feels like one continuous pill that morphs in place.
 */
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
    <div className="mb-2">
      <div className="inline-flex items-center px-2 py-1 -ml-2 rounded-lg text-[12.5px] font-medium text-foreground/65">
        <ShimmerText>Thinking…</ShimmerText>
      </div>
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
        <div className="px-1 text-foreground/85">
          <ThinkingIndicator />
          <AssistantContent />
          <MessageActionBar variant="assistant" />
        </div>
      </motion.div>
    </MessagePrimitive.Root>
  );
}

/**
 * Renders the assistant message's content parts in order, grouping
 * consecutive non-`propose_action` tool-call parts into a single
 * ChatToolGroup card. We deliberately bypass `MessagePrimitive.Content`
 * (which renders parts one-by-one through per-type slots) because
 * grouping requires looking at the whole array.
 *
 * The only source of "thinking" text we surface is native `reasoning`
 * parts emitted by the backend from model-provider fields.
 *
 * Ordering invariants we rely on (enforced by LiveContentBuilder):
 *   - reasoning / text deltas fold into the trailing same-type part
 *   - a tool-call closes the open text and reasoning cursors so any
 *     later deltas start fresh parts AFTER the tool
 * → therefore a reasoning part is still "streaming" iff the message is
 *   running AND its containing part is the very last item in the content array.
 */
function AssistantContent() {
  const parts = useMessage((m) => m.content);
  const isRunning = useMessage((m) => m.status?.type === "running");
  const { renderProposeActionAsText } = useChatRenderOptions();

  const blocks: ReactNode[] = [];
  let toolBuffer: ChatToolGroupItem[] = [];
  let groupKey = 0;

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    blocks.push(
      <ChatToolGroup key={`group-${groupKey++}`} tools={toolBuffer} />,
    );
    toolBuffer = [];
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (part.type === "tool-call") {
      if (part.toolName === "propose_action") {
        // HITL pause panel — never grouped. Flush any preceding tools
        // first so the propose_action card sits at the right ordinal.
        flushTools();
        if (renderProposeActionAsText) {
          const text = proposeActionTextFromArgs(part.args);
          if (text) {
            blocks.push(<MarkdownContent key={`pa-text-${part.toolCallId}`} text={text} />);
          }
        } else {
          blocks.push(
            <ProposeActionCard
              key={`pa-${part.toolCallId}`}
              args={part.args}
            />,
          );
        }
      } else {
        toolBuffer.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.args as ChatToolGroupItem["args"],
          result: part.result as ChatToolGroupItem["result"],
          isError: part.isError,
        });
      }
    } else if (part.type === "text") {
      flushTools();
      if (part.text) {
        blocks.push(<MarkdownContent key={`t-${i}`} text={part.text} />);
      }
    } else if (part.type === "reasoning") {
      flushTools();
      blocks.push(
        <ReasoningBlock
          key={`r-${i}`}
          text={part.text}
          shimmer={isRunning}
          appending={isRunning && isLast}
        />,
      );
    }
    // Other part types (source/file/image/data) aren't produced by our
    // backend and are intentionally ignored.
  }
  flushTools();

  return <>{blocks}</>;
}

const PULL_DOWN_THRESHOLD_PX = 100;
const PULL_DOWN_TOP_TOLERANCE_PX = 4;

export default function MainChatView({
  sessionKey,
  runtime,
  historyLoaded,
  onBack,
  title,
  subtitle,
  headerSlot,
  emptyMessage = "Send a message to start chatting",
  inputPlaceholder,
  emptyState = null,
  renderProposeActionAsText = false,
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

  // Ref to the viewport's scroll element. Used by the pull-down gesture
  // handler to confirm we're at the top of the message list before
  // treating a downward swipe as a "back" intent.
  const viewportRef = useRef<HTMLDivElement>(null);
  const touchStartYRef = useRef<number | null>(null);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  }, []);
  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const startY = touchStartYRef.current;
      touchStartYRef.current = null;
      if (startY === null || title) return; // disable pull-down in card chat
      const delta = (e.changedTouches[0]?.clientY ?? startY) - startY;
      const atTop =
        (viewportRef.current?.scrollTop ?? 0) <= PULL_DOWN_TOP_TOLERANCE_PX;
      if (atTop && delta > PULL_DOWN_THRESHOLD_PX) {
        onBack();
      }
    },
    [onBack, title],
  );

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
    <div
      className="absolute inset-0 z-50 font-native overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Aurora background — same system as ConstellationLayout +
          MinimalistLanding so the visual continuity holds when the user
          slides up into a conversation from the landing page. */}
      <img
        src={bgGradient}
        alt=""
        className="absolute inset-0 w-full h-full object-cover opacity-60"
        aria-hidden="true"
      />
      <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
      <div className="absolute inset-0 bg-white/35" />

      <div className="relative z-10 flex flex-col h-full">
      {title ? (
        // CardChat header — keep the title/subtitle bar so the user can
        // see which card the conversation is about.
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
              aria-label="Back"
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
      ) : (
        // Main-chat header — minimalist; only a chevron back. The thread
        // is a singleton so no title is meaningful. Matches the reference
        // MinimalistConversation top bar.
        <div className="shrink-0 flex items-center px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3">
          <button
            onClick={onBack}
            className="p-2 -ml-1 rounded-full hover:bg-foreground/[0.06] transition-colors"
            aria-label="Back"
          >
            <ChevronDown
              size={20}
              strokeWidth={1.5}
              className="text-foreground/65"
            />
          </button>
        </div>
      )}

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
          runtime={runtime}
          historyLoaded={historyLoaded}
          viewportRef={viewportRef}
          topOffset={browserStage === "mini" ? 32 : 0}
          emptyState={emptyState}
          inputPlaceholder={inputPlaceholder}
          composerFocused={composerFocused}
          onComposerFocusChange={setComposerFocused}
          renderProposeActionAsText={renderProposeActionAsText}
        />

        <BrowserPanel
          session={
            browserSession
              ? {
                  browserSessionId: browserSession.sessionKey,
                  liveViewUrl: browserSession.liveViewUrl,
                  viewport: browserSession.viewport,
                  deviceKind: browserSession.deviceKind,
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
      </div>
    </div>
  );
}

/**
 * Wires the parent-supplied runtime into the assistant-ui primitive tree.
 * Owns:
 *   - keyboard visibility tracking (Capacitor Keyboard events)
 *   - the ThreadPrimitive subtree (viewport / messages / footer / composer)
 *   - the composer's local text state (we deliberately don't use
 *     ComposerPrimitive.Input — see ChatComposer notes)
 */
function ChatRuntimeScope({
  sessionKey,
  runtime,
  historyLoaded,
  viewportRef,
  topOffset,
  emptyState,
  inputPlaceholder,
  composerFocused,
  onComposerFocusChange,
  renderProposeActionAsText,
}: {
  sessionKey: string;
  runtime: AssistantRuntime;
  historyLoaded: boolean;
  viewportRef: React.Ref<HTMLDivElement>;
  /** px of top padding so messages aren't clipped behind the mini drag bar. */
  topOffset: number;
  emptyState?: ReactNode;
  inputPlaceholder?: string;
  composerFocused: boolean;
  onComposerFocusChange: (focused: boolean) => void;
  renderProposeActionAsText: boolean;
}) {
  // Composer text is local to ChatComposer (it's a controlled textarea).
  // Lifting it up here was used briefly for an "Edit prefills composer"
  // pattern, but that's now replaced by assistant-ui's in-place edit
  // composer (see `UserEditComposer` below + `ActionBarPrimitive.Edit`
  // in MessageActionBar) so the thread-composer state stays local.

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
          <ThreadPrimitive.Viewport
            ref={viewportRef}
            className="flex-1 overflow-y-auto px-4 py-4"
          >
            <ThreadPrimitive.Empty>{emptyState}</ThreadPrimitive.Empty>

            <ChatRenderOptionsContext.Provider value={{ renderProposeActionAsText }}>
              <ThreadPrimitive.Messages
                components={{
                  UserMessage,
                  AssistantMessage,
                  UserEditComposer,
                }}
              />
            </ChatRenderOptionsContext.Provider>

            <ThreadPrimitive.ViewportFooter />
          </ThreadPrimitive.Viewport>

          {/* Footer cluster — ScrollToBottom is anchored to this container's
              top edge, so when TodoPanel expands/collapses (or the keyboard
              pushes everything up) the chevron stays the same offset above
              the composer without manual height bookkeeping. */}
          <div className="relative shrink-0">
            <ThreadPrimitive.ScrollToBottom className="absolute -top-12 right-4 z-10 p-2 rounded-full glass-card-strong shadow-md hover:bg-foreground/10 transition-colors">
              <ChevronDown size={16} className="text-foreground/60" />
            </ThreadPrimitive.ScrollToBottom>

            <TodoPanel sessionKey={sessionKey} composerFocused={composerFocused} />

            <ChatComposer
              inputPlaceholder={inputPlaceholder}
              kbVisible={kbVisible}
              onDismissKeyboard={handleDismissKeyboard}
              onComposerFocusChange={onComposerFocusChange}
            />
          </div>
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

  const canSend = !!text.trim() && !isRunning;
  return (
    <div className="shrink-0 px-3 pb-6 pt-2">
      <div
        className="flex items-end gap-2 pl-4 pr-2 py-2 rounded-3xl border border-foreground/[0.08] focus-within:border-foreground/[0.18] transition-colors"
        style={{
          background: "rgba(255,255,255,0.6)",
          backdropFilter: "blur(20px) saturate(1.5)",
          WebkitBackdropFilter: "blur(20px) saturate(1.5)",
          boxShadow: "0 4px 24px hsl(0 0% 0% / 0.04)",
        }}
        onFocusCapture={() => onComposerFocusChange(true)}
        onBlurCapture={() => onComposerFocusChange(false)}
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={inputPlaceholder ?? "Message PIN AI…"}
          rows={1}
          className="flex-1 resize-none bg-transparent text-[15px] text-foreground placeholder:text-foreground/35 outline-none leading-[20px] py-2 min-h-9 max-h-[120px]"
        />
        {kbVisible && (
          <button
            type="button"
            // preventDefault so click doesn't blur the textarea before
            // our handler runs.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDismissKeyboard}
            className="w-9 h-9 rounded-full flex items-center justify-center text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/80 transition-colors shrink-0"
            title="Dismiss keyboard"
          >
            <ChevronDown size={18} strokeWidth={1.6} />
          </button>
        )}
        <VoiceButton
          prefill={text}
          onUpdate={setText}
          size={18}
          className="w-9 h-9 rounded-full bg-transparent text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/80"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSend}
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-95"
          style={
            canSend
              ? {
                  background:
                    "linear-gradient(135deg, hsl(292 78% 63%) 0%, hsl(330 80% 65%) 100%)",
                  boxShadow: "0 4px 12px hsl(292 78% 63% / 0.35)",
                  color: "hsl(var(--background))",
                }
              : {
                  background: "hsl(var(--foreground) / 0.08)",
                  color: "hsl(var(--foreground) / 0.35)",
                }
          }
          aria-label="Send"
        >
          <Send size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
