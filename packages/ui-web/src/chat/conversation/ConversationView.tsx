/**
 * ConversationView — the unified conversation surface for main chat + card
 * execution. They differ only by session key + props, not by component. Driven
 * by `useConversationRuntime`:
 *   - user messages    → right-aligned dark bubble (UserEntry)
 *   - assistant turns  → text segments as the narrative spine; the
 *                        reasoning/tool/task runs between them as collapsible
 *                        WorkGroup rails (AssistantEntry → work-group.ts).
 *   - notify_user      → the agent's outreach, rendered with its own "Notify
 *                        you" chrome (NotifyCard).
 *
 * It's a push stream — the user sends and the server pushes turns into ONE
 * transcript; the composer calls `sendMessage`. This file is the thin
 * orchestrator: session resolution + runtime + browser panel + scroll policy +
 * header/transcript/footer composition. The transcript entries, composer,
 * browser panel and feedback bars live in sibling modules.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, Check, ChevronDown, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import bgGradient from "../../assets/bg-gradient.jpg";
import { cn } from "../../lib/utils";
import { notifyThreadActivity, readLocalHistory } from "../../local-sync";
import { useChatScroll } from "./scroll/useChatScroll";
import JumpToLatest from "./scroll/JumpToLatest";
import TodoPanel from "./TodoPanel";
import BrowserHeader from "../../browser/BrowserHeader";
import BrowserDrawer from "../../browser/BrowserDrawer";
import { useConversationRuntime } from "@pin-ai/state";
import {
  conversationInit,
  deriveCardResultMessageId,
  feedbackChannelForSession,
  splitQueuedEntries,
} from "@pin-ai/core";
import { Text } from "../../primitives/Text";
import { FeedbackChannelContext } from "./_shared";
import { TranscriptView } from "./TranscriptView";
import { Composer } from "./Composer";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";
import { CardResultFeedbackBar } from "./CardResultFeedbackBar";
import { useBrowserPanel } from "./useBrowserPanel";

interface ConversationViewProps {
  onBack: () => void;
  /** Explicit thread to address (resume / card). `card-thread-<id>` → a card
   *  execution thread. When omitted, `kind` decides which thread to resolve. */
  session?: string;
  /** Which thread to resolve when `session` is omitted (the FE can't know the
   *  user_id, so it asks by kind). Defaults to the user's main-chat singleton. */
  kind?: "main" | "card";
  /** Card JSON injected on the first send (feedback-from-card / card open). */
  cardContext?: Record<string, unknown>;
  /** Auto-fired first user message when the thread starts empty. */
  bootstrap?: string;
  /** Header title (card chat shows the card title; main chat defaults). */
  title?: string;
  /** Extra header content (e.g. a card's context summary / browser controls). */
  headerSlot?: ReactNode;
  /** Composer placeholder (card chat shows a card-specific prompt). */
  placeholder?: string;
  /** Card chat only: mark the card complete (POSTs feedback). When set, a
   *  "Done" button shows in the header; on success the chat closes (onBack). */
  onDone?: () => void | Promise<void>;
  /** Card chat only: dismiss the card (POSTs feedback). When set, a "Dismiss"
   *  button shows in the header; on success the chat closes (onBack). */
  onDismiss?: () => void | Promise<void>;
  /** Back-button icon. Card chat is a full-screen page → "left" (ArrowLeft,
   *  go-back semantic, per the design). Main chat keeps "down" (ChevronDown,
   *  the dismiss-the-sheet semantic). */
  backIcon?: "down" | "left";
  /** Fired on every chat:done (agent turn ended). Card chat uses it to sync
   *  the card's sphere/timeline status the moment the agent finishes. */
  onTurnDone?: () => void;
  /** Card chat: enables the result feedback bar (design's "done" toolbar)
   *  above the composer once the agent's final result is in. Thumbs write
   *  chat_message_feedback themselves; `onComment` persists a text_feedback
   *  (pure learning signal — it does NOT message the agent; steering stays in
   *  the composer); `onDone` completes the card, then the chat closes. */
  cardFeedback?: {
    onDone: () => boolean | void | Promise<boolean | void>;
    onComment: (text: string) => void | Promise<void>;
  };
  /** Desktop (wide) only: when the browser panel opens, render it as a left
   *  split column beside the chat instead of a bottom-sheet drawer. The host
   *  must widen this view's container in response to onBrowserSplitChange
   *  (the chat keeps its width; the browser takes the freed space). Narrow
   *  hosts (phone-width web / Capacitor) omit this → always the drawer. */
  enableBrowserSplit?: boolean;
  /** Fired when the browser split activates / deactivates so the host shell
   *  can widen / restore this view. Only meaningful with enableBrowserSplit. */
  onBrowserSplitChange?: (active: boolean) => void;
}

/** Split layout: the chat column keeps this width on the right; the browser
 *  takes the rest on the left. ~standard comfortable chat reading width. */
const SPLIT_CHAT_WIDTH = 480;

export default function ConversationView({
  onBack,
  session,
  kind = "main",
  cardContext,
  bootstrap,
  title,
  headerSlot,
  placeholder,
  onDone,
  onDismiss,
  backIcon = "down",
  onTurnDone,
  cardFeedback,
  enableBrowserSplit = false,
  onBrowserSplitChange,
}: ConversationViewProps) {
  const { t } = useTranslation(["chat", "common"]);
  // Resolve the explicit session_key for the unified conversation runtime.
  // card / explicit main: pass the given session through. "" until resolved →
  // the runtime idles.
  const [sessionKey, setSessionKey] = useState(session ?? "");
  useEffect(() => {
    if (session) {
      setSessionKey(session);
      return;
    }
    let cancelled = false;
    conversationInit({ kind })
      .then((r) => {
        if (!cancelled) setSessionKey(r.sessionKey);
      })
      .catch((e) => console.warn("[conversation] init failed:", e));
    return () => {
      cancelled = true;
    };
  }, [session, kind]);
  const {
    transcript, ready, sendMessage, busy, retryMessage, stop,
    updateQueuedMessage, deleteQueuedMessage, interruptQueuedMessage,
    threadId,
    hasMoreHistory, loadMoreHistory,
    awaitingDecision, submitDecision,
  } = useConversationRuntime({
    session: sessionKey,
    cardContext,
    bootstrap,
    // Sync-B3a 门铃：turn 落库（chat:persisted/done）后立即增量同步该
    // thread 进本地库（native 引擎未启动时 no-op）。读切换是 B3b。
    onTurnPersisted: notifyThreadActivity,
    // B3b 读路径：本地优先首屏（引擎未启动时返回 null → 纯网络现状）。
    localHistory: readLocalHistory,
    // 卡片层门铃：chat:done / HITL 暂停时立即回传，球面/Tasks 状态不等轮询。
    onTurnDone,
  });
  // 访问驱动同步（lazy incomplete model）：打开任何 thread 拉一次增量，
  // card threads 由此按需进入本地库（不全量扫）。
  useEffect(() => {
    if (sessionKey) notifyThreadActivity(sessionKey);
  }, [sessionKey]);
  // Card-chat lifecycle (Done / Dismiss) — POSTs feedback then closes the chat.
  // `busy` guards against double-taps while the POST is in flight.
  const [lifecycleBusy, setLifecycleBusy] = useState<null | "done" | "dismiss">(null);
  const runLifecycle = useCallback(
    async (kind: "done" | "dismiss", action?: () => void | Promise<void>) => {
      if (!action || lifecycleBusy) return;
      setLifecycleBusy(kind);
      try {
        await action();
        onBack();
      } catch (err) {
        console.warn(`[proactive] card ${kind} failed:`, err);
        setLifecycleBusy(null);
      }
    },
    [lifecycleBusy, onBack],
  );
  // `busy` (from the runtime) is true from send until the turn ends — used for
  // the composer Stop/gate + propose_action Continue gating, so it reacts the
  // instant the user sends (not only once `chat:thinking` lands). A separate
  // `hasRunningTurn` (a turn actually streaming in the transcript) gates the
  // pending "Thinking…" pill, which only fills the pre-stream cold-start gap.
  const { visible: visibleTranscript, queued: queuedEntries } = useMemo(
    () => splitQueuedEntries(transcript),
    [transcript],
  );
  const hasRunningTurn = visibleTranscript.some((e) => e.kind === "assistant" && e.running);
  // Feedback channel for this surface — recorded on 👍/👎 events so reward
  // analytics can tell which conversation type they came from.
  const feedbackChannel = feedbackChannelForSession(sessionKey);

  // Card result bar visibility: the turn is settled (not busy, no HITL gate)
  // and the LAST entry is a finalized assistant turn with visible text and no
  // propose_action — a proposal means "needs your decision", not a result.
  // undefined = hide the bar; null = show it, thumbs disabled until the
  // backend message id lands (chat:persisted); string = show fully armed.
  const cardResultMessageId: string | null | undefined = useMemo(
    () =>
      !cardFeedback || busy || awaitingDecision
        ? undefined
        : deriveCardResultMessageId(visibleTranscript),
    [cardFeedback, busy, awaitingDecision, visibleTranscript],
  );

  // Browser live view (state + input wiring extracted to useBrowserPanel).
  const {
    browserSessionKey,
    browserSession,
    browserPanelOpen,
    browserLayout,
    canSplitBrowser,
    browserAttention,
    browserViewEl,
    closeBrowserPanel,
    handleBrowserHeaderOpen,
  } = useBrowserPanel(threadId, enableBrowserSplit, onBrowserSplitChange);
  const [composerFocused, setComposerFocused] = useState(false);

  // Scroll policy (reading-first): useChatScroll owns the follow/free state
  // machine, the send anchor and the jump affordance; TranscriptView wires it
  // into Virtuoso. Sends route through anchorToSend so the new user message
  // lands at the viewport top with the reply streaming into the runway below.
  const scroll = useChatScroll({ session: sessionKey, transcript: visibleTranscript });
  const { anchorToSend } = scroll;
  const sendAndAnchor = useCallback(
    (text: string) => {
      const p = sendMessage(text); // appends the optimistic bubble synchronously
      if (!busy) anchorToSend();
      return p;
    },
    [sendMessage, busy, anchorToSend],
  );
  const retryAndAnchor = useCallback(
    (id: string, text: string) => {
      void retryMessage(id, text);
      anchorToSend();
    },
    [retryMessage, anchorToSend],
  );
  const handleDecide = useCallback(
    (d: "approve" | "reject", message?: string) => void submitDecision(d, message),
    [submitDecision],
  );

  return (
    <div className="absolute inset-0 z-0 overflow-hidden font-native bg-background">
      <img
        src={bgGradient}
        alt=""
        className="absolute inset-0 h-full w-full object-cover opacity-60"
        aria-hidden="true"
      />
      <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
      <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
      <div className="absolute inset-0 bg-white/35" />

      <div className="relative z-10 flex h-full flex-col">
        {/* Header — back chevron + title + (card) Done·Dismiss. */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+12px)]",
            // Card chat carries a context card below → divider under the title
            // row (matches design). Main chat passes no headerSlot.
            headerSlot && "border-b border-foreground/8",
          )}
        >
          <button
            onClick={onBack}
            className="-ml-1 rounded-full p-2 transition-colors hover:bg-foreground/[0.06]"
            aria-label={t("header.back")}
          >
            {backIcon === "left" ? (
              <ArrowLeft
                size={20}
                strokeWidth={1.5}
                className="text-foreground/65"
              />
            ) : (
              <ChevronDown
                size={20}
                strokeWidth={1.5}
                className="text-foreground/65"
              />
            )}
          </button>
          <div className={cn("min-w-0 flex-1", headerSlot && "pr-12")}>
            {/* Card chat shows the card title; main chat has no title (the
                landing's greeting carries it). The card context card is NOT
                here — it renders full-width BELOW this header row (see below),
                so the back button + title stay on one line (matches design).
                pr-12 (card chat only) reserves room for the floating hamburger
                menu (AppLayout's ☰, absolute top-right) so a long title
                truncates with "…" BEFORE it instead of overlapping. */}
            {title && (
              <h2 className="text-display truncate text-body text-foreground">
                {title}
              </h2>
            )}
          </div>
          {/* Card-chat lifecycle controls. Dismiss / Done POST feedback so the
              card moves off the sphere into TASKS, then close the chat. */}
          {(onDismiss || onDone) && (
            <div className="flex items-center gap-1.5">
              {onDismiss && (
                <button
                  type="button"
                  onClick={() => void runLifecycle("dismiss", onDismiss)}
                  disabled={lifecycleBusy !== null}
                  className="flex items-center gap-1 rounded-full px-2.5 py-1 text-caption font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.06] disabled:opacity-40"
                >
                  {lifecycleBusy === "dismiss" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <X size={12} strokeWidth={2} />
                  )}
                  {t("header.dismiss")}
                </button>
              )}
              {onDone && (
                <button
                  type="button"
                  onClick={() => void runLifecycle("done", onDone)}
                  disabled={lifecycleBusy !== null}
                  className="flex items-center gap-1 rounded-full bg-foreground/90 px-2.5 py-1 text-caption font-medium text-background transition-colors hover:bg-foreground disabled:opacity-40"
                >
                  {lifecycleBusy === "done" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Check size={12} strokeWidth={2.5} />
                  )}
                  {t("common:status.done")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Card chat's context card renders full-width BELOW the header row
            (design: back + title share one line, context card is its own
            block). Main chat passes no headerSlot → nothing here. */}
        {headerSlot}

        {/* Chat region. With the browser open as a split (wide opted-in hosts)
            this row is horizontal — browser left (flex-1), chat keeps its
            width on the right. Otherwise it's a column and the browser, if
            open, is a bottom-sheet drawer over the chat. */}
        <div
          className={cn(
            "relative flex min-h-0 flex-1",
            browserLayout === "split" ? "flex-row" : "flex-col",
          )}
        >
          {browserLayout === "split" && (
            <div className="relative min-w-0 flex-1 border-r border-foreground/10">
              {browserViewEl}
            </div>
          )}

          <div
            className={cn(
              "flex min-h-0 flex-col",
              browserLayout === "split" ? "shrink-0" : "flex-1",
            )}
            style={browserLayout === "split" ? { width: SPLIT_CHAT_WIDTH } : undefined}
          >
            {/* Transcript + the floating jump-to-latest affordance. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              <FeedbackChannelContext.Provider value={feedbackChannel}>
                <TranscriptView
                  ready={ready}
                  transcript={visibleTranscript}
                  busy={busy}
                  hasRunningTurn={hasRunningTurn}
                  scroll={scroll}
                  hasMoreHistory={hasMoreHistory}
                  loadMoreHistory={loadMoreHistory}
                  sendMessage={sendAndAnchor}
                  retryMessage={retryAndAnchor}
                  onUpdateQueued={updateQueuedMessage}
                  onDeleteQueued={deleteQueuedMessage}
                  onInterruptQueued={interruptQueuedMessage}
                  awaitingDecision={awaitingDecision}
                  onDecide={handleDecide}
                />
              </FeedbackChannelContext.Provider>
              <JumpToLatest
                visible={scroll.showJump}
                attention={scroll.hasNewBelow || (!!awaitingDecision && scroll.mode === "free")}
                onClick={scroll.jumpToLatest}
              />
            </div>

            {/* Footer: browser header (session exists, panel closed) + agent
                plan + composer. The HITL approval gate renders inline on the
                paused turn (TranscriptView), not here. */}
            <div className="relative shrink-0">
              {browserSession && !browserPanelOpen && (
                <div className="px-3 pb-1">
                  <BrowserHeader
                    currentUrl={browserSession.currentUrl}
                    attention={browserAttention}
                    attentionReason={browserSession.takeoverReason}
                    onOpen={handleBrowserHeaderOpen}
                  />
                </div>
              )}
              <TodoPanel sessionKey={browserSessionKey} composerFocused={composerFocused} />
              {cardFeedback && cardResultMessageId !== undefined && (
                <CardResultFeedbackBar
                  messageId={cardResultMessageId}
                  channel={feedbackChannel}
                  onComment={cardFeedback.onComment}
                  onDone={() =>
                    void runLifecycle("done", async () => {
                      await cardFeedback.onDone();
                    })
                  }
                  doneBusy={lifecycleBusy === "done"}
                />
              )}
              <QueuedMessagesPanel
                entries={queuedEntries}
                onUpdateQueued={updateQueuedMessage}
                onDeleteQueued={deleteQueuedMessage}
                onInterruptQueued={interruptQueuedMessage}
              />
              <Composer
                onSend={sendAndAnchor}
                onFocusChange={setComposerFocused}
                placeholder={placeholder}
                streaming={busy}
                onStop={stop}
              />
            </div>
          </div>
        </div>

        {/* Drawer-capable hosts (narrow / no split): a full-screen bottom sheet
            covering the WHOLE conversation incl. the chat header, so the browser
            owns the screen (its own control + URL bars are the top chrome). Kept
            mounted so the slide-down exit plays on collapse; `open` drives
            visibility + mounts the live view inside. */}
        {browserSession && !canSplitBrowser && (
          <BrowserDrawer open={browserPanelOpen} onClose={closeBrowserPanel}>
            {browserViewEl}
          </BrowserDrawer>
        )}
      </div>
    </div>
  );
}
