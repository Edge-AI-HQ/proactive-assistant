/**
 * ConversationView — the unified conversation surface for all three chat
 * sessions (main chat / card execution / proactive). They differ only by
 * session key + props, not by component. Driven by `useConversationRuntime`:
 *   - heartbeats       → muted "system" entries (a proactive tick's input)
 *   - user messages    → right-aligned dark bubble
 *   - assistant turns  → text segments as the narrative spine; the
 *                        reasoning/tool/task runs between them as collapsible
 *                        WorkGroup rails (work-group.ts / WorkGroup / TaskCard
 *                        / MarkdownContent).
 *   - notify_user      → the agent's proactive outreach, rendered with its
 *                        own "Notify you" chrome (NotifyCard); always shown
 *                        (even in a debug-hidden heartbeat turn).
 *
 * It's a push stream — user sends and server-pushed turns (proactive ticks,
 * card fanout) both flow into ONE transcript; the composer calls `sendMessage`.
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion } from "framer-motion";
import { Virtuoso, type Components } from "react-virtuoso";
import { AlertCircle, ArrowLeft, Check, ChevronDown, Copy, Loader2, MessageSquarePlus, Mic, Pencil, Radio, RotateCcw, Send, Sparkles, Square, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import bgGradient from "../../assets/bg-gradient.jpg";
import { cn } from "../../lib/utils";
import { useMediaQuery } from "../../lib/use-media-query";
import { notifyThreadActivity, readLocalHistory } from "../../local-sync";
import MarkdownContent from "./MarkdownContent";
import { buildAssistantMessageFeedbackBody } from "@pin-ai/core";
// The shared animated orb — looping video with a buffering reveal so the
// landing hero doesn't flash dark when the Ask PIN AI sheet opens.
import AiSphere from "../../now/AiSphere";
import { ShimmerText } from "./ReasoningBlock";
import WorkGroup from "./WorkGroup";
import { segmentAssistantParts } from "@pin-ai/core";
import ProposeActionCard from "./ProposeActionCard";
import { HitlApprovalCard, type HitlRequiresAction } from "./HitlApprovalCard";
import { useChatScroll, type ChatScrollApi } from "./scroll/useChatScroll";
import JumpToLatest from "./scroll/JumpToLatest";
import TodoPanel from "./TodoPanel";
import BrowserView from "../../browser/BrowserView";
import BrowserHeader from "../../browser/BrowserHeader";
import BrowserDrawer from "../../browser/BrowserDrawer";
import { useBrowserSession } from "../../browser/useBrowserSession";
import { isNative } from "../../auth/platform";
import { useVoiceInput, Waveform, appendVoiceTranscript } from "../../voice";
import { useConversationRuntime } from "@pin-ai/state";
import { type ConversationAssistantEntry, type ConversationEntry, type ConversationUserEntry, type ConversationContentPart, conversationInit, proxyPost } from "@pin-ai/core";
import { Text } from "../../primitives/Text";

interface ConversationViewProps {
  onBack: () => void;
  /** Explicit thread to address (resume / card). `card-thread-<id>` → a card
   *  execution thread. When omitted, `kind` decides which thread to resolve. */
  session?: string;
  /** Which thread to resolve when `session` is omitted (the FE can't know the
   *  user_id, so it asks by kind): "proactive" (default, heartbeat-capable) or
   *  "main" (the user's main-chat singleton). */
  kind?: "main" | "proactive";
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
   *  go-back semantic, per the design). Main chat / proactive keep "down"
   *  (ChevronDown, the dismiss-the-sheet semantic). */
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

/** Extract the agent's outreach text from a `notify_user` tool-call part's
 *  snapshot args (structured `input.message`, else the preview string). */
function notifyUserText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const inner =
    root.input && typeof root.input === "object"
      ? (root.input as Record<string, unknown>)
      : root;
  const msg = typeof inner.message === "string" ? inner.message.trim() : "";
  if (msg) return msg;
  const preview = typeof root.argsPreview === "string" ? root.argsPreview.trim() : "";
  return preview || null;
}

function formatRecordDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const LANDING_SUGGESTIONS = [
  "What should I focus on today?",
  "Summarize my week so far",
  "What's on my mind lately?",
];

/** Split layout: the chat column keeps this width on the right; the browser
 *  takes the rest on the left. ~standard comfortable chat reading width. */
const SPLIT_CHAT_WIDTH = 480;

/** Proactive-thread empty state — the greeting shown when the proactive
 *  transcript is empty: idle orb + prompt + suggestion chips. Tapping a chip
 *  (or typing in the composer below) starts the thread. */
function ProactiveLanding({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    // min-h-full + justify-center centers the greeting when it fits, and lets
    // the column scroll instead of clipping when it doesn't (small screens).
    <div className="flex min-h-full flex-col items-center justify-center pb-4">
      <div className="mb-7">
        <AiSphere size={216} mode="idle" />
      </div>
      <Text as="h2" variant="display" weight="semibold" className="text-display px-6 text-center tracking-tight">
        What&apos;s on your mind?
      </Text>
      <Text variant="bodySm" className="block mt-2 px-8 text-center leading-snug text-foreground/50">
        Ask anything — I have your context.
      </Text>
      <div className="mt-8 flex w-full flex-col gap-2">
        {LANDING_SUGGESTIONS.map((s, i) => (
          <motion.button
            key={s}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, delay: 0.12 + i * 0.05, ease: [0.32, 0.72, 0, 1] }}
            onClick={() => onPick(s)}
            className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-foreground/[0.08] px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03]"
            style={{
              background: "rgba(255,255,255,0.45)",
              backdropFilter: "blur(20px) saturate(1.4)",
              WebkitBackdropFilter: "blur(20px) saturate(1.4)",
            }}
          >
            <Text variant="bodySm" className="leading-snug text-foreground/75">{s}</Text>
            <span className="shrink-0 text-foreground/30 transition-colors group-hover:text-foreground/55">
              →
            </span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

/** Wall-clock HH:MM AM/PM for a message timestamp. Returns null for an
 *  invalid / zero ts. */
function formatClockTime(ts: number): string | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

/** Concatenated plain text of an assistant turn (for Copy). */
function assistantPlainText(parts: ConversationContentPart[]): string {
  const texts: string[] = [];
  for (const p of parts) if (p.type === "text") texts.push(p.text);
  return texts.join("\n\n").trim();
}

const ACTION_BTN = cn(
  "inline-flex items-center justify-center w-7 h-7 rounded-lg",
  "text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.06]",
  "transition-colors",
);
const ACTION_BTN_ACTIVE = cn(
  "inline-flex items-center justify-center w-7 h-7 rounded-lg",
  "text-foreground bg-foreground/[0.08] transition-colors",
);

/** The feedback `channel` for the current conversation (main_chat /
 *  card_execution / proactive). ConversationView provides it so the action
 *  bar's 👍/👎 records which surface the feedback came from, without drilling
 *  the value through every transcript entry. */
const FeedbackChannelContext = createContext<string>("main_chat");

/** Action bar under a finalized assistant turn: Copy + 👍/👎 + Regenerate(last
 *  only). Thumbs write `pai_feedback_events` keyed by the backend
 *  pai_chat_messages id, so they only render once the entry carries a real
 *  (numeric) id — a live turn adopts it via the `chat:persisted` frame moments
 *  after chat:done; history turns already load with it. */
function AssistantActionBar({
  messageId,
  plainText,
  isLast,
  onRegenerate,
}: {
  messageId: string;
  plainText: string;
  isLast: boolean;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const channel = useContext(FeedbackChannelContext);
  const hasBackendId = /^\d+$/.test(messageId);

  const copy = useCallback(() => {
    if (!plainText) return;
    void navigator.clipboard?.writeText(plainText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [plainText]);

  const sendFeedback = useCallback(
    (next: "up" | "down") => {
      const effective = feedback === next ? null : next;
      setFeedback(effective);
      const body = buildAssistantMessageFeedbackBody(messageId, effective, channel);
      if (!body) return;
      // Best-effort persistence; keep the local reaction responsive on failure.
      void proxyPost("/feedback", body).catch(() => {});
    },
    [feedback, messageId, channel],
  );

  return (
    <div className="mt-2 flex items-center gap-0.5 pl-0.5">
      {plainText ? (
        <button type="button" onClick={copy} className={ACTION_BTN} aria-label="Copy message" title="Copy">
          {copied ? (
            <Check size={13} strokeWidth={2} className="text-emerald-500" />
          ) : (
            <Copy size={13} strokeWidth={1.6} />
          )}
        </button>
      ) : null}
      {hasBackendId ? (
        <>
          <button
            type="button"
            onClick={() => sendFeedback("up")}
            className={feedback === "up" ? ACTION_BTN_ACTIVE : ACTION_BTN}
            aria-label="Good response"
            title="Good response"
          >
            <ThumbsUp size={13} strokeWidth={1.6} fill={feedback === "up" ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            onClick={() => sendFeedback("down")}
            className={feedback === "down" ? ACTION_BTN_ACTIVE : ACTION_BTN}
            aria-label="Bad response"
            title="Bad response"
          >
            <ThumbsDown size={13} strokeWidth={1.6} fill={feedback === "down" ? "currentColor" : "none"} />
          </button>
        </>
      ) : null}
      {isLast && onRegenerate ? (
        <button type="button" onClick={onRegenerate} className={ACTION_BTN} aria-label="Regenerate response" title="Regenerate">
          <RotateCcw size={13} strokeWidth={1.6} />
        </button>
      ) : null}
    </div>
  );
}

/** Card chat result bar — ported from the design repo's ChatDetailView "done"
 *  toolbar ("Was this helpful?" + 👍/👎 + Comment), plus a Done pill (the
 *  product needs an explicit accept action to retire the card; the design
 *  left it implicit). All three write REAL feedback:
 *    👍/👎  → /feedback chat_message_feedback on the final assistant message
 *            (same pipe as AssistantActionBar; disabled until the message id
 *            arrives via chat:persisted)
 *    Comment → `onComment` → /feedback text_feedback on the card (learning
 *            signal for the next generation run — never messages the agent)
 *    Done   → completes the card (latestOutcome=complete) + closes the chat */
function CardResultFeedbackBar({
  messageId,
  channel,
  onComment,
  onDone,
  doneBusy,
}: {
  messageId: string | null;
  /** Passed explicitly (not via FeedbackChannelContext) — the bar renders in
   *  the footer, outside the transcript's provider. */
  channel: string;
  onComment: (text: string) => void | Promise<void>;
  onDone: () => void;
  doneBusy: boolean;
}) {
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentSent, setCommentSent] = useState(false);

  const sendThumbs = useCallback(
    (next: "up" | "down") => {
      if (!messageId) return;
      const effective = feedback === next ? null : next;
      setFeedback(effective);
      const body = buildAssistantMessageFeedbackBody(
        messageId,
        effective,
        channel,
        "card_result_bar",
      );
      if (!body) return;
      void proxyPost("/feedback", body).catch(() => {});
    },
    [feedback, messageId, channel],
  );

  const submitComment = useCallback(() => {
    const text = commentText.trim();
    if (!text) return;
    void Promise.resolve(onComment(text)).catch(() => {});
    setCommentText("");
    setCommentOpen(false);
    setCommentSent(true);
  }, [commentText, onComment]);

  return (
    <div className="px-4 pb-2">
      <div
        className="flex items-center justify-between gap-2 rounded-2xl border border-foreground/8 px-3 py-2"
        style={{ background: "rgba(255,255,255,0.5)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)" }}
      >
        <Text variant="label" weight="medium" className="whitespace-nowrap text-foreground/55">
          Helpful?
        </Text>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => sendThumbs("up")}
            disabled={!messageId}
            aria-label="Helpful"
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${feedback === "up" ? "bg-green-500/20 text-green-600" : "bg-foreground/5 text-foreground/55 hover:bg-foreground/10"}`}
          >
            <ThumbsUp size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => sendThumbs("down")}
            disabled={!messageId}
            aria-label="Not helpful"
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${feedback === "down" ? "bg-red-500/20 text-red-600" : "bg-foreground/5 text-foreground/55 hover:bg-foreground/10"}`}
          >
            <ThumbsDown size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => setCommentOpen((v) => !v)}
            disabled={commentSent}
            className="ml-0.5 flex h-8 items-center gap-1 whitespace-nowrap rounded-full bg-foreground/5 px-2.5 text-label font-medium text-foreground/65 transition-colors hover:bg-foreground/10 disabled:opacity-60"
          >
            {commentSent ? (
              <>
                <Check size={12} strokeWidth={2.5} /> Sent
              </>
            ) : (
              <>
                <MessageSquarePlus size={12} strokeWidth={2} /> Comment
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onDone}
            disabled={doneBusy}
            className="flex h-8 items-center gap-1 whitespace-nowrap rounded-full bg-foreground px-3 text-label font-semibold text-background transition-colors hover:bg-foreground/85 disabled:opacity-40"
          >
            {doneBusy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Check size={13} strokeWidth={2.5} />
            )}{" "}
            Done
          </button>
        </div>
      </div>
      {commentOpen && (
        <div className="mt-2 flex items-center gap-2">
          <input
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              // IME composition guard (same idiom as the main Composer):
              // confirming a candidate with Enter must not submit half-typed
              // text as a feedback event.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") submitComment();
            }}
            placeholder="Feedback on this card (won't message the agent)…"
            className="h-9 flex-1 rounded-full border border-foreground/10 bg-white/60 px-4 text-bodySm text-foreground placeholder:text-foreground/35 focus:outline-none"
          />
          <button
            type="button"
            onClick={submitComment}
            disabled={!commentText.trim()}
            aria-label="Send feedback"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
          >
            <Send size={14} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}

function UserEntry({
  entry,
  onRetry,
  isLast,
  onEdit,
  onUpdateQueued,
  onDeleteQueued,
  onInterruptQueued,
}: {
  entry: ConversationUserEntry;
  onRetry: (id: string, text: string) => void;
  /** This is the latest user turn → show the Edit affordance. */
  isLast?: boolean;
  /** Prefill the composer with this turn's text for the user to revise and
   *  re-send as a NEW turn (the original bubble stays as-is). */
  onEdit?: (text: string) => void;
  onUpdateQueued?: (id: string, text: string) => Promise<void>;
  onDeleteQueued?: (id: string) => Promise<void>;
  onInterruptQueued?: (id: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [editingQueued, setEditingQueued] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [queueBusy, setQueueBusy] = useState<null | "edit" | "delete" | "send">(null);
  const clockLabel = formatClockTime(entry.ts);
  const isQueued = !!entry.queued;

  useEffect(() => {
    if (!editingQueued) setDraft(entry.text);
  }, [entry.text, editingQueued]);

  const copy = useCallback(() => {
    if (!entry.text) return;
    void navigator.clipboard?.writeText(entry.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [entry.text]);

  const saveQueuedEdit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || !onUpdateQueued) return;
    setQueueBusy("edit");
    void onUpdateQueued(entry.id, trimmed).finally(() => {
      setQueueBusy(null);
      setEditingQueued(false);
    });
  }, [draft, entry.id, onUpdateQueued]);

  const deleteQueued = useCallback(() => {
    if (!onDeleteQueued) return;
    setQueueBusy("delete");
    void onDeleteQueued(entry.id).finally(() => setQueueBusy(null));
  }, [entry.id, onDeleteQueued]);

  const sendQueuedNow = useCallback(() => {
    if (!onInterruptQueued) return;
    setQueueBusy("send");
    void onInterruptQueued(entry.id).finally(() => setQueueBusy(null));
  }, [entry.id, onInterruptQueued]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="mb-4 flex flex-col items-end"
    >
      <div
        className={cn(
          "max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-foreground/90 px-4 py-2.5 text-bodySm leading-relaxed text-background",
          entry.failed && "opacity-50",
          editingQueued && "w-[82%]",
        )}
      >
        {editingQueued ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                saveQueuedEdit();
              }
              if (e.key === "Escape") {
                setDraft(entry.text);
                setEditingQueued(false);
              }
            }}
            rows={2}
            className="max-h-28 min-h-[44px] w-full resize-none bg-transparent text-background outline-none placeholder:text-background/50"
            autoFocus
          />
        ) : (
          entry.text
        )}
      </div>
      {entry.failed ? (
        <button
          type="button"
          onClick={() => onRetry(entry.id, entry.text)}
          className="mt-1 flex items-center gap-1 text-caption font-medium text-red-500 transition-colors hover:text-red-600"
        >
          <AlertCircle size={11} strokeWidth={2} />
          Not sent
          <span className="text-foreground/40">·</span>
          <RotateCcw size={10} strokeWidth={2} />
          Retry
        </button>
      ) : (
        <div className="mt-1 flex items-center gap-1 pr-0.5">
          {isQueued ? (
            <Text variant="caption" weight="medium" className="mr-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-foreground/45">
              Queued
            </Text>
          ) : clockLabel ? (
            <Text variant="caption" weight="medium" className="tabular-nums text-foreground/40">
              {clockLabel}
            </Text>
          ) : null}
          {!isQueued ? (
            <button type="button" onClick={copy} className={ACTION_BTN} aria-label="Copy message" title="Copy">
              {copied ? (
                <Check size={13} strokeWidth={2} className="text-emerald-500" />
              ) : (
                <Copy size={13} strokeWidth={1.6} />
              )}
            </button>
          ) : null}
          {isQueued && editingQueued ? (
            <>
              <button
                type="button"
                onClick={saveQueuedEdit}
                disabled={queueBusy !== null || !draft.trim()}
                className={ACTION_BTN}
                aria-label="Save queued message"
                title="Save"
              >
                {queueBusy === "edit" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={13} strokeWidth={2} />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(entry.text);
                  setEditingQueued(false);
                }}
                disabled={queueBusy !== null}
                className={ACTION_BTN}
                aria-label="Cancel queued edit"
                title="Cancel"
              >
                <X size={13} strokeWidth={1.8} />
              </button>
            </>
          ) : isQueued ? (
            <>
              <button
                type="button"
                onClick={() => setEditingQueued(true)}
                disabled={queueBusy !== null}
                className={ACTION_BTN}
                aria-label="Edit queued message"
                title="Edit"
              >
                <Pencil size={13} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                onClick={sendQueuedNow}
                disabled={queueBusy !== null}
                className={ACTION_BTN}
                aria-label="Send now"
                title="Send now"
              >
                {queueBusy === "send" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} strokeWidth={1.8} />
                )}
              </button>
              <button
                type="button"
                onClick={deleteQueued}
                disabled={queueBusy !== null}
                className={ACTION_BTN}
                aria-label="Delete queued message"
                title="Delete"
              >
                {queueBusy === "delete" ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Trash2 size={13} strokeWidth={1.8} />
                )}
              </button>
            </>
          ) : isLast && onEdit ? (
            <button
              type="button"
              onClick={() => onEdit(entry.text)}
              className={ACTION_BTN}
              aria-label="Edit message"
              title="Edit"
            >
              <Pencil size={13} strokeWidth={1.8} />
            </button>
          ) : null}
        </div>
      )}
    </motion.div>
  );
}

function QueuedMessagesPanel({
  entries,
  onUpdateQueued,
  onDeleteQueued,
  onInterruptQueued,
}: {
  entries: ConversationUserEntry[];
  onUpdateQueued: (id: string, text: string) => Promise<void>;
  onDeleteQueued: (id: string) => Promise<void>;
  onInterruptQueued: (id: string) => Promise<void>;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="px-8">
      <div
        role="region"
        aria-label="Queued messages"
        className="mb-[-1px] overflow-hidden rounded-t-[22px] rounded-b-none border border-foreground/[0.10] bg-white/56 shadow-[0_1px_14px_hsl(0_0%_0%/0.03)] backdrop-blur-[20px]"
      >
        <div className="divide-y divide-foreground/[0.06]">
          {entries.map((entry) => (
            <QueuedMessageRow
              key={entry.id}
              entry={entry}
              onUpdateQueued={onUpdateQueued}
              onDeleteQueued={onDeleteQueued}
              onInterruptQueued={onInterruptQueued}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function QueuedMessageRow({
  entry,
  onUpdateQueued,
  onDeleteQueued,
  onInterruptQueued,
}: {
  entry: ConversationUserEntry;
  onUpdateQueued: (id: string, text: string) => Promise<void>;
  onDeleteQueued: (id: string) => Promise<void>;
  onInterruptQueued: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [busy, setBusy] = useState<null | "edit" | "delete" | "send">(null);

  useEffect(() => {
    if (!editing) setDraft(entry.text);
  }, [entry.text, editing]);

  const save = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy("edit");
    void onUpdateQueued(entry.id, trimmed).finally(() => {
      setBusy(null);
      setEditing(false);
    });
  }, [draft, entry.id, onUpdateQueued]);

  const remove = useCallback(() => {
    setBusy("delete");
    void onDeleteQueued(entry.id).finally(() => setBusy(null));
  }, [entry.id, onDeleteQueued]);

  const sendNow = useCallback(() => {
    setBusy("send");
    void onInterruptQueued(entry.id).finally(() => setBusy(null));
  }, [entry.id, onInterruptQueued]);

  return (
    <div className="flex min-h-[48px] items-center gap-2 px-4 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Send size={14} strokeWidth={1.7} className="shrink-0 text-foreground/35" />
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              }
              if (e.key === "Escape") {
                setDraft(entry.text);
                setEditing(false);
              }
            }}
            rows={1}
            className="max-h-20 min-h-7 flex-1 resize-none bg-transparent py-1 text-body leading-5 text-foreground/70 outline-none placeholder:text-foreground/35"
            autoFocus
          />
        ) : (
          <Text variant="bodySm" weight="medium" className="min-w-0 truncate leading-5 text-foreground/62">
            {entry.text}
          </Text>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {editing ? (
          <>
            <button
              type="button"
              onClick={save}
              disabled={busy !== null || !draft.trim()}
              className={ACTION_BTN}
              aria-label="Save queued message"
              title="Save"
            >
              {busy === "edit" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Check size={13} strokeWidth={2} />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(entry.text);
                setEditing(false);
              }}
              disabled={busy !== null}
              className={ACTION_BTN}
              aria-label="Cancel queued edit"
              title="Cancel"
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={busy !== null}
              className={ACTION_BTN}
              aria-label="Edit queued message"
              title="Edit"
            >
              <Pencil size={13} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={sendNow}
              disabled={busy !== null}
              className={ACTION_BTN}
              aria-label="Send now"
              title="Send now"
            >
              {busy === "send" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Send size={13} strokeWidth={1.8} />
              )}
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy !== null}
              className={ACTION_BTN}
              aria-label="Delete queued message"
              title="Delete"
            >
              {busy === "delete" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} strokeWidth={1.8} />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * `notify_user` — the agent's proactive outreach. Rendered with its own
 * "Notify you" chrome (Sparkles + uppercase magenta label + glassy magenta-
 * tinted card, echoing the ambient surface) so it reads as the AI reaching out
 * on its own, not as a reply to something the user said. Same in live and
 * history replay.
 */
function NotifyCard({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
      className="mb-4 overflow-hidden rounded-2xl border border-[hsl(304_75%_55%)]/20 px-4 py-3"
      style={{
        background:
          "radial-gradient(120% 80% at 0% 0%, hsl(304 75% 60% / 0.10) 0%, transparent 55%), rgba(255,255,255,0.5)",
        backdropFilter: "blur(20px) saturate(1.4)",
        WebkitBackdropFilter: "blur(20px) saturate(1.4)",
      }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles size={11} strokeWidth={2} className="text-[hsl(304_75%_45%)]" />
        <Text variant="micro" weight="bold" className="uppercase tracking-[0.18em] text-[hsl(304_75%_45%)]">
          Notify you
        </Text>
      </div>
      <MarkdownContent text={text} />
    </motion.div>
  );
}

/**
 * Renders an assistant turn's ordered parts under the work-group model:
 * text segments are the narrative spine; the reasoning/tool/task runs
 * between them render as collapsible WorkGroup rails (segmentation lives
 * in work-group.ts so the invariants stay unit-testable).
 */
function AssistantEntry({
  entry,
  onReply,
  busy,
  debugEnabled,
  isLast,
  onRegenerate,
  hitlAction,
  onDecide,
}: {
  entry: ConversationAssistantEntry;
  /** Wired to the runtime's sendMessage for propose_action replies. */
  onReply: (text: string) => Promise<void>;
  /** A turn is currently streaming on this thread. */
  busy: boolean;
  /** When false, a debug (heartbeat-triggered) turn renders ONLY its
   *  notify_user parts — thinking / tools / inline text are hidden. */
  debugEnabled: boolean;
  /** This is the latest assistant turn → show the Regenerate affordance. */
  isLast?: boolean;
  /** Drop this turn and re-run the latest user message (regenerate=true). */
  onRegenerate?: () => void;
  /** This turn paused on a HITL approval → render the gate where the
   *  stream stopped (after the turn's streamed parts). */
  hitlAction?: HitlRequiresAction | null;
  onDecide?: (decision: "approve" | "reject", message?: string) => void;
}) {
  const { parts, running } = entry;
  // Heartbeat-triggered turn with Debug off → surface only notify_user.
  const debugHidden = !!entry.debug && !debugEnabled;
  const visibleParts: ConversationContentPart[] = debugHidden
    ? parts.filter((p) => p.type === "tool-call" && p.toolName === "notify_user")
    : parts;
  const segments = segmentAssistantParts(visibleParts);
  const blocks: ReactNode[] = [];
  segments.forEach((seg, idx) => {
    if (seg.kind === "text") {
      blocks.push(<MarkdownContent key={seg.key} text={seg.text} />);
      return;
    }
    if (seg.kind === "special") {
      if (seg.part.toolName === "propose_action") {
        // HITL pause panel — never inside a work group. Reply chips /
        // Continue route through the runtime's sendMessage (onReply).
        blocks.push(
          <ProposeActionCard
            key={seg.key}
            args={seg.part.args}
            onReply={onReply}
            busy={busy}
          />,
        );
        return;
      }
      // notify_user — the agent's proactive outreach, with its own chrome.
      const msg = notifyUserText(seg.part.args);
      if (msg) blocks.push(<NotifyCard key={seg.key} text={msg} />);
      return;
    }
    // A work group streams while it's the turn's live tail; the moment text
    // (or any later segment) lands after it, it settles and collapses.
    blocks.push(
      <WorkGroup
        key={seg.key}
        group={seg.group}
        streaming={running && idx === segments.length - 1}
      />,
    );
  });

  const showHitl = !!hitlAction && !!onDecide;
  // First-token-pending: turn is running but nothing has streamed yet. A
  // hidden debug turn never shows the pill (it's a background heartbeat
  // turn), and neither does a HITL pause — a paused run isn't "thinking".
  const showThinkingPill = running && parts.length === 0 && !debugHidden && !showHitl;
  // Hidden debug turn that produced no notify_user → render nothing (no empty
  // bubble taking vertical space).
  if (blocks.length === 0 && !showThinkingPill && !showHitl) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="mb-5"
    >
      <div className="px-1 text-foreground/85">
        {showThinkingPill ? (
          <div className="mb-2">
            <div className="inline-flex items-center -ml-2 rounded-lg px-2 py-1 text-label font-medium text-foreground/65">
              <ShimmerText>Thinking…</ShimmerText>
            </div>
          </div>
        ) : (
          <>
            {blocks}
            {!running && !debugHidden ? (
              <AssistantActionBar
                messageId={entry.id}
                plainText={assistantPlainText(parts)}
                isLast={!!isLast}
                onRegenerate={onRegenerate}
              />
            ) : null}
          </>
        )}
        {hitlAction && onDecide ? (
          <div className="pt-1">
            <HitlApprovalCard action={hitlAction} disabled={busy} onDecide={onDecide} />
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

function TranscriptEntry({
  entry,
  onReply,
  onRetry,
  onEdit,
  onUpdateQueued,
  onDeleteQueued,
  onInterruptQueued,
  onRegenerate,
  isLastUser,
  isLastAssistant,
  busy,
  debugEnabled,
  hitlAction,
  onDecide,
}: {
  entry: ConversationEntry;
  onReply: (text: string) => Promise<void>;
  onRetry: (id: string, text: string) => void;
  onEdit: (text: string) => void;
  onUpdateQueued: (id: string, text: string) => Promise<void>;
  onDeleteQueued: (id: string) => Promise<void>;
  onInterruptQueued: (id: string) => Promise<void>;
  onRegenerate: () => void;
  isLastUser: boolean;
  isLastAssistant: boolean;
  busy: boolean;
  debugEnabled: boolean;
  /** Set on the paused HITL turn's entry only (see TranscriptView). */
  hitlAction?: HitlRequiresAction | null;
  onDecide?: (decision: "approve" | "reject", message?: string) => void;
}) {
  // Heartbeats are debug-only. When shown, they're just the input that
  // triggered the turn → render as a plain user bubble (no special UI).
  if (entry.kind === "heartbeat") {
    return debugEnabled ? (
      <UserEntry
        entry={{ kind: "user", id: entry.id, ts: entry.ts, text: entry.text }}
        onRetry={() => {}}
      />
    ) : null;
  }
  if (entry.kind === "user")
    return (
      <UserEntry
        entry={entry}
        onRetry={onRetry}
        isLast={isLastUser}
        onEdit={onEdit}
        onUpdateQueued={onUpdateQueued}
        onDeleteQueued={onDeleteQueued}
        onInterruptQueued={onInterruptQueued}
      />
    );
  return (
    <AssistantEntry
      entry={entry}
      onReply={onReply}
      busy={busy}
      debugEnabled={debugEnabled}
      isLast={isLastAssistant}
      onRegenerate={onRegenerate}
      hitlAction={hitlAction}
      onDecide={onDecide}
    />
  );
}

interface TranscriptViewProps {
  ready: boolean;
  isProactive: boolean;
  transcript: ConversationEntry[];
  busy: boolean;
  hasRunningTurn: boolean;
  debugEnabled: boolean;
  /** Scroll policy owner (state machine + commands) — see scroll/useChatScroll. */
  scroll: ChatScrollApi;
  hasMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  retryMessage: (id: string, text: string) => void;
  onEdit: (text: string) => void;
  onUpdateQueued: (id: string, text: string) => Promise<void>;
  onDeleteQueued: (id: string) => Promise<void>;
  onInterruptQueued: (id: string) => Promise<void>;
  onRegenerate: () => void;
  /** Paused HITL run → render the approval gate inline on the paused turn. */
  awaitingDecision: HitlRequiresAction | null;
  onDecide: (decision: "approve" | "reject", message?: string) => void;
}

/** Variable data for the (identity-stable) Virtuoso Footer, passed via the
 *  `context` prop so changes update props instead of remounting the Footer
 *  subtree — a remount would drop the fallback HitlApprovalCard's local
 *  input state. */
interface TranscriptFooterContext {
  busy: boolean;
  hasRunningTurn: boolean;
  awaitingDecision: HitlRequiresAction | null;
  hitlHostId: string | null;
  onDecide: (decision: "approve" | "reject", message?: string) => void;
  runwayPx: number;
}

/** Footer = the HITL fallback for host-less pauses (a debug-hidden turn never
 *  flushed an entry), the pre-stream "Thinking…" pill (only reachable when a
 *  send couldn't open its optimistic placeholder — a foreign heartbeat turn
 *  held the builder), and the runway spacer the send anchor scrolls against
 *  (see useChatScroll). */
function TranscriptFooter({ context }: { context?: TranscriptFooterContext }) {
  if (!context) return null;
  const { busy, hasRunningTurn, awaitingDecision, hitlHostId, onDecide, runwayPx } = context;
  return (
    <>
      {awaitingDecision && !hitlHostId ? (
        <div className="mb-5 px-4 pt-1">
          <HitlApprovalCard action={awaitingDecision} disabled={busy} onDecide={onDecide} />
        </div>
      ) : null}
      {!awaitingDecision && busy && !hasRunningTurn ? (
        <div className="mb-5 px-4 pt-1">
          <div className="inline-flex items-center -ml-2 rounded-lg px-2 py-1 text-label font-medium text-foreground/65">
            <ShimmerText>Thinking…</ShimmerText>
          </div>
        </div>
      ) : null}
      <div style={{ height: runwayPx }} aria-hidden="true" />
    </>
  );
}

const TRANSCRIPT_COMPONENTS: Components<ConversationEntry, TranscriptFooterContext> = {
  Footer: TranscriptFooter,
};

/** Transcript viewport (react-virtuoso). Three render modes share the
 *  flex-1 slot below the header:
 *    - !ready                       → loading placeholder
 *    - ready & transcript empty     → landing (main thread) or radio prompt
 *    - ready & transcript non-empty → virtualized list of TranscriptEntry
 *  Virtuoso is a pure virtualized list here — `followOutput={false}` and all
 *  scrolling (send anchor, follow pin, jump) goes through `scroll`
 *  (useChatScroll), which reads back `atBottomStateChange` /
 *  `totalListHeightChanged` / `scrollerRef`. `startReached` still triggers an
 *  older-page load when the user pulls up, with `firstItemIndex` (managed
 *  below) preserving the visual position when the page prepends. */
function TranscriptView({
  ready,
  isProactive,
  transcript,
  busy,
  hasRunningTurn,
  debugEnabled,
  scroll,
  hasMoreHistory,
  loadMoreHistory,
  sendMessage,
  retryMessage,
  onEdit,
  onUpdateQueued,
  onDeleteQueued,
  onInterruptQueued,
  onRegenerate,
  awaitingDecision,
  onDecide,
}: TranscriptViewProps) {
  // `firstItemIndex` is a virtual offset that lets prepended history pages
  // keep their visual position. Start high and decrement by the number of
  // items prepended (detected by head id change + growth; appends and
  // in-place turn updates leave it alone).
  const VIRTUOSO_START_INDEX = 1_000_000_000;
  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUOSO_START_INDEX);
  const headIdRef = useRef<string | null>(null);
  const lenRef = useRef(0);
  useLayoutEffect(() => {
    const head = transcript[0]?.id ?? null;
    if (
      headIdRef.current
      && head !== headIdRef.current
      && transcript.length > lenRef.current
    ) {
      const prepended = transcript.length - lenRef.current;
      setFirstItemIndex((prev) => prev - prepended);
    }
    headIdRef.current = head;
    lenRef.current = transcript.length;
  }, [transcript]);

  // The paused HITL turn hosts its approval card inline (right where the
  // stream stopped). Host = the last assistant entry, still running. A turn
  // hidden by the Debug filter never flushed an entry → Footer fallback.
  const hitlHostId = useMemo(() => {
    if (!awaitingDecision) return null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i];
      if (e.kind === "assistant") return e.running ? e.id : null;
    }
    return null;
  }, [awaitingDecision, transcript]);

  const footerContext = useMemo<TranscriptFooterContext>(
    () => ({
      busy,
      hasRunningTurn,
      awaitingDecision,
      hitlHostId,
      onDecide,
      runwayPx: scroll.runwayPx,
    }),
    [busy, hasRunningTurn, awaitingDecision, hitlHostId, onDecide, scroll.runwayPx],
  );
  const onStartReached = useCallback(() => {
    if (hasMoreHistory) void loadMoreHistory();
  }, [hasMoreHistory, loadMoreHistory]);

  // Identify the latest user / assistant turn so only they show the
  // Edit / Regenerate affordances (matching ConversationView's action-bar gating).
  const { lastUserId, lastAssistantId } = useMemo(() => {
    let u: string | null = null;
    let a: string | null = null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i];
      if (!u && e.kind === "user") u = e.id;
      if (!a && e.kind === "assistant") a = e.id;
      if (u && a) break;
    }
    return { lastUserId: u, lastAssistantId: a };
  }, [transcript]);

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-foreground/40" />
          <Text variant="bodySm" className="text-foreground/40">Loading…</Text>
        </div>
      </div>
    );
  }
  if (transcript.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {isProactive ? (
          <ProactiveLanding onPick={(p) => void sendMessage(p)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <Radio size={22} strokeWidth={1.5} className="text-foreground/30" />
            <Text variant="bodySm" className="block text-foreground/45">
              Ask the agent to act on this card, or send it a message.
            </Text>
          </div>
        )}
      </div>
    );
  }
  return (
    <Virtuoso
      ref={scroll.virtuosoRef}
      className="scrollbar-hidden"
      style={{ flex: 1 }}
      data={transcript}
      firstItemIndex={firstItemIndex}
      initialTopMostItemIndex={{ index: transcript.length - 1, align: "end" }}
      computeItemKey={(_index, entry) => entry.id}
      itemContent={(_index, entry) => (
        <div className="px-4" data-entry-id={entry.id}>
          <TranscriptEntry
            entry={entry}
            onReply={sendMessage}
            onRetry={retryMessage}
            onEdit={onEdit}
            onUpdateQueued={onUpdateQueued}
            onDeleteQueued={onDeleteQueued}
            onInterruptQueued={onInterruptQueued}
            onRegenerate={onRegenerate}
            isLastUser={entry.id === lastUserId}
            isLastAssistant={entry.id === lastAssistantId}
            busy={busy}
            debugEnabled={debugEnabled}
            hitlAction={entry.id === hitlHostId ? awaitingDecision : null}
            onDecide={onDecide}
          />
        </div>
      )}
      startReached={onStartReached}
      followOutput={false}
      atBottomThreshold={48}
      atBottomStateChange={scroll.handleAtBottomChange}
      totalListHeightChanged={scroll.handleTotalHeightChange}
      scrollerRef={scroll.handleScrollerRef}
      increaseViewportBy={400}
      context={footerContext}
      components={TRANSCRIPT_COMPONENTS}
    />
  );
}

/** iOS-style on/off switch for the proactive heartbeat. */
function HeartbeatToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Proactive agent on/off"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-primary border-primary" : "bg-foreground/15 border-foreground/15",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked ? "translate-x-[22px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

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
  // Debug message visibility: heartbeats + heartbeat-triggered turns (except
  // notify_user). A dev aid; persisted in localStorage so it survives reload.
  // Read BEFORE the runtime hook so the initial history fetch matches the
  // user's stored preference (no flash of unfiltered/filtered content).
  const [debugEnabled, setDebugEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pinai:debugMessages") === "1";
    } catch {
      return false;
    }
  });
  const setDebug = useCallback((next: boolean) => {
    setDebugEnabled(next);
    try {
      localStorage.setItem("pinai:debugMessages", next ? "1" : "0");
    } catch {
      /* private mode / storage disabled — keep in-memory state only */
    }
  }, []);
  // Resolve the explicit session_key for the unified conversation runtime.
  // proactive: the FE can't know user_id, so it asks by kind. card / explicit
  // main: pass the given session through. "" until resolved → the runtime idles.
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
    transcript, ready, sendMessage, busy, retryMessage, stop, regenerateLast,
    updateQueuedMessage, deleteQueuedMessage, interruptQueuedMessage,
    enabled, setEnabled, threadId,
    hasMoreHistory, loadMoreHistory,
    awaitingDecision, submitDecision,
  } = useConversationRuntime({
    session: sessionKey,
    cardContext,
    bootstrap,
    debugEnabled,
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
  const { visibleTranscript, queuedEntries } = useMemo(() => {
    const visible: ConversationEntry[] = [];
    const queued: ConversationUserEntry[] = [];
    for (const entry of transcript) {
      if (entry.kind === "user" && entry.queued) queued.push(entry);
      else visible.push(entry);
    }
    return { visibleTranscript: visible, queuedEntries: queued };
  }, [transcript]);
  const hasRunningTurn = visibleTranscript.some((e) => e.kind === "assistant" && e.running);
  // Heartbeat / listening toggle only applies to the proactive thread; main +
  // card threads are purely user-driven.
  const isProactive = sessionKey.startsWith("proactive-");
  // Feedback channel for this surface — recorded on 👍/👎 events so reward
  // analytics can tell which conversation type they came from.
  const feedbackChannel = isProactive
    ? "proactive"
    : sessionKey.startsWith("card-thread-")
      ? "card_execution"
      : "main_chat";

  // Card result bar visibility: the turn is settled (not busy, no HITL gate)
  // and the LAST entry is a finalized assistant turn with visible text and no
  // propose_action — a proposal means "needs your decision", not a result.
  // undefined = hide the bar; null = show it, thumbs disabled until the
  // backend message id lands (chat:persisted); string = show fully armed.
  const cardResultMessageId: string | null | undefined = useMemo(() => {
    if (!cardFeedback || busy || awaitingDecision) return undefined;
    const last = visibleTranscript[visibleTranscript.length - 1];
    if (!last || last.kind !== "assistant" || last.running) return undefined;
    const hasText = last.parts.some((p) => p.type === "text" && p.text.trim().length > 0);
    const hasProposal = last.parts.some(
      (p) => p.type === "tool-call" && p.toolName === "propose_action",
    );
    if (!hasText || hasProposal) return undefined;
    return /^\d+$/.test(last.id) ? last.id : null;
  }, [cardFeedback, busy, awaitingDecision, visibleTranscript]);

  // Message Edit prefills the composer (imperative — the composer owns its
  // draft state, which also absorbs voice-transcript appends).
  const composerRef = useRef<ComposerHandle>(null);
  const handleEditEntry = useCallback((text: string) => {
    composerRef.current?.setDraft(text);
  }, []);

  // ── browser live view (same hookup as the old ConversationView) ──
  // Keyed by the resolved thread id so browser_tool's session for THIS thread
  // streams into the panel. Empty until the thread id is known (main thread is
  // server-resolved via the stream hello) — useBrowserSession idles on "".
  const browserSessionKey = threadId ?? "";
  const {
    session: browserSession,
    panelOpen: browserPanelOpen,
    openPanel: openBrowserPanel,
    closePanel: closeBrowserPanel,
    setControl,
    sendInput,
    refreshLiveView,
    close: closeBrowser,
  } = useBrowserSession(browserSessionKey);
  const [composerFocused, setComposerFocused] = useState(false);

  // Browser panel layout. Wide hosts that opted into split render it as a left
  // column beside the chat; everything else (phone-width) gets a bottom-sheet
  // drawer. Hidden until the user opens it from the header (default closed).
  const wideViewport = useMediaQuery("(min-width: 1024px)");
  const canSplitBrowser = enableBrowserSplit && wideViewport;
  const browserLayout: "hidden" | "split" | "drawer" =
    !browserSession || !browserPanelOpen
      ? "hidden"
      : canSplitBrowser
        ? "split"
        : "drawer";
  // Ask the host shell to widen this view for the split (chat keeps its width;
  // the browser takes the freed space). The drawer needs no host change.
  const browserSplitActive = browserLayout === "split";
  useEffect(() => {
    onBrowserSplitChange?.(browserSplitActive);
  }, [browserSplitActive, onBrowserSplitChange]);

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

  // On foreground return, iOS may pause the Live View WebSocket + expire its
  // signed iframe URL. Refresh the URL then bump the iframe key (don't remount
  // the transcript — that would drop the in-flight stream / composer draft).
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
    void import("@capacitor/app")
      .then(({ App }) =>
        App.addListener("appStateChange", (state) => {
          if (state.isActive) bump();
        }),
      )
      .then((l) => {
        capListener = l;
      })
      .catch(() => {});
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void capListener?.remove();
    };
  }, [refreshLiveView]);

  // BrowserView speaks (mode, key, dx, dy); wrap the hook's typed sendInput.
  const handleUserInputText = useCallback(
    (text: string) => sendInput({ type: "text", text }).then(() => undefined),
    [sendInput],
  );
  const handleUserInputKey = useCallback(
    (key: string) => sendInput({ type: "key", key }).then(() => undefined),
    [sendInput],
  );
  const handleUserInputScroll = useCallback(
    (dx: number, dy: number) =>
      sendInput({ type: "scroll", dx, dy }).then(() => undefined),
    [sendInput],
  );
  const handleUserInputTap = useCallback(
    (x: number, y: number) =>
      sendInput({ type: "tap", x, y }).then((r) => !!(r && r.editableFocused)),
    [sendInput],
  );
  const handleBrowserControlChange = useCallback(
    (mode: "ai" | "user") => void setControl(mode),
    [setControl],
  );
  const handleBrowserClose = useCallback(() => void closeBrowser(), [closeBrowser]);
  const handleBrowserBack = useCallback(() => void sendInput({ type: "back" }), [sendInput]);
  const handleBrowserForward = useCallback(
    () => void sendInput({ type: "forward" }),
    [sendInput],
  );
  const handleBrowserReload = useCallback(
    () => void sendInput({ type: "reload" }),
    [sendInput],
  );
  const handleBrowserNavigate = useCallback(
    (url: string) => void sendInput({ type: "navigate", url }),
    [sendInput],
  );
  // Header click opens the panel. If the AI asked for help (attention state),
  // the user opening it means they're stepping in → take control for them.
  const browserAttention = !!browserSession?.takeoverReason;
  const handleBrowserHeaderOpen = useCallback(() => {
    openBrowserPanel();
    if (browserAttention && browserSession?.controlMode !== "user") {
      void setControl("user");
    }
  }, [openBrowserPanel, browserAttention, browserSession?.controlMode, setControl]);

  // One BrowserView element reused by whichever layout is active (split column
  // or drawer — they're mutually exclusive, so only one renders).
  const browserViewEl = browserSession ? (
    <BrowserView
      liveViewUrl={browserSession.liveViewUrl}
      sessionId={browserSession.sessionKey}
      controlMode={browserSession.controlMode}
      iframeReloadKey={iframeReloadKey}
      isNative={isNative}
      viewport={browserSession.viewport}
      currentUrl={browserSession.currentUrl}
      onControlChange={handleBrowserControlChange}
      onUserInputTap={handleUserInputTap}
      onUserInputText={handleUserInputText}
      onUserInputKey={handleUserInputKey}
      onUserInputScroll={handleUserInputScroll}
      onBack={handleBrowserBack}
      onForward={handleBrowserForward}
      onReload={handleBrowserReload}
      onNavigate={handleBrowserNavigate}
      onCollapse={closeBrowserPanel}
      onRequestClose={handleBrowserClose}
    />
  ) : null;

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
        {/* Header — back chevron + title + (main) Proactive toggle / (card)
            Done·Dismiss. */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+12px)]",
            // Card chat carries a context card below → divider under the title
            // row (matches design). Main chat / proactive pass no headerSlot.
            headerSlot && "border-b border-foreground/8",
          )}
        >
          <button
            onClick={onBack}
            className="-ml-1 rounded-full p-2 transition-colors hover:bg-foreground/[0.06]"
            aria-label="Back"
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
          {/* Proactive on/off — main-thread only. The toggle itself shows
              on/off, so the label stays static "Proactive" (no connection
              status to read). A card execution thread is user-driven and never
              heartbeats; its stream robustness is handled silently by the
              runtime's reconnect/resync, with no toggle. */}
          {isProactive && (
            <div className="flex items-center gap-2">
              {/* Debug: show hidden heartbeat / heartbeat-triggered messages. */}
              <Text variant="label" weight="medium" className="text-foreground/55">
                Debug
              </Text>
              <HeartbeatToggle
                checked={debugEnabled}
                disabled={false}
                onChange={setDebug}
              />
              <Text variant="label" weight="medium" className="ml-1 text-foreground/55">
                Proactive
              </Text>
              <HeartbeatToggle
                checked={enabled === true}
                disabled={enabled === null}
                onChange={(next) => void setEnabled(next)}
              />
            </div>
          )}
          {/* Card-chat lifecycle controls. Dismiss / Done POST feedback so the
              card moves off the sphere into TASKS, then close the chat. */}
          {!isProactive && (onDismiss || onDone) && (
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
                  Dismiss
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
                  Done
                </button>
              )}
            </div>
          )}
        </div>

        {/* Card chat's context card renders full-width BELOW the header row
            (design: back + title share one line, context card is its own
            block). Main chat / proactive pass no headerSlot → nothing here. */}
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
                  isProactive={isProactive}
                  transcript={visibleTranscript}
                  busy={busy}
                  hasRunningTurn={hasRunningTurn}
                  debugEnabled={debugEnabled}
                  scroll={scroll}
                  hasMoreHistory={hasMoreHistory}
                  loadMoreHistory={loadMoreHistory}
                  sendMessage={sendAndAnchor}
                  retryMessage={retryAndAnchor}
                  onEdit={handleEditEntry}
                  onUpdateQueued={updateQueuedMessage}
                  onDeleteQueued={deleteQueuedMessage}
                  onInterruptQueued={interruptQueuedMessage}
                  onRegenerate={regenerateLast}
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
                ref={composerRef}
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

interface ComposerHandle {
  /** Replace the draft and focus the input (used by message Edit). */
  setDraft: (text: string) => void;
}

const Composer = forwardRef<
  ComposerHandle,
  {
    onSend: (text: string) => Promise<void>;
    onFocusChange?: (focused: boolean) => void;
    placeholder?: string;
    /** A turn is streaming on this thread → the send button becomes a Stop
     *  button and sending is gated (Claude/ChatGPT model: stop first, then send). */
    streaming?: boolean;
    onStop?: () => void | Promise<void>;
  }
>(function Composer(
  { onSend, onFocusChange, placeholder, streaming = false, onStop },
  ref,
) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      setDraft: (next: string) => {
        setText(next);
        // Defer focus so the value commits first; place the caret at the end.
        window.setTimeout(() => {
          const ta = taRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(next.length, next.length);
        }, 0);
      },
    }),
    [],
  );

  // Track keyboard visibility (events dispatched from main.tsx on Capacitor
  // Keyboard willShow/willHide) so we can offer a dismiss-keyboard button on
  // mobile — same affordance the old ConversationView composer had.
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

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  }, [text]);

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setText("");
    setSending(true);
    try {
      await onSend(trimmed);
    } catch (err) {
      console.warn("[proactive] send failed:", err);
    } finally {
      setSending(false);
    }
  }, [text, sending, onSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  // ── Inline voice recording (reference Conversation.tsx UI on our real
  //    engine). The input bar morphs into a recording bar: live transcript +
  //    duration + waveform + Cancel/Confirm. Confirm fills the input (appends
  //    to any draft) so the user can review and send. ──
  const { startCapture, stopCapture, captureStatus } = useVoiceInput();
  const [recording, setRecording] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceFinalizing, setVoiceFinalizing] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const recordingRef = useRef(false);

  const startRecording = useCallback(() => {
    setVoiceTranscript("");
    setVoiceFinalizing(false);
    setRecordSec(0);
    setRecording(true);
    startCapture({
      inline: true,
      onUpdate: setVoiceTranscript,
      onError: setVoiceTranscript,
      onResult: (final) => {
        // Append the transcript to the existing draft, then leave it in the
        // input for the user to review / edit / send (not auto-sent).
        setText((prev) => appendVoiceTranscript(prev, final));
        setRecording(false);
        setVoiceFinalizing(false);
        setVoiceTranscript("");
        // Refocus so the keyboard returns and the user can keep editing.
        window.setTimeout(() => taRef.current?.focus(), 0);
      },
    });
  }, [startCapture]);

  const cancelRecording = useCallback(() => {
    void stopCapture(false);
    setRecording(false);
    setVoiceFinalizing(false);
    setVoiceTranscript("");
  }, [stopCapture]);

  const confirmRecording = useCallback(() => {
    setVoiceFinalizing(true); // onResult clears it + exits recording
    void stopCapture(true);
  }, [stopCapture]);

  // Recording duration ticker.
  useEffect(() => {
    if (!recording) return;
    const startedAt = Date.now();
    const t = window.setInterval(
      () => setRecordSec(Math.floor((Date.now() - startedAt) / 1000)),
      250,
    );
    return () => window.clearInterval(t);
  }, [recording]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  // Cancel an in-flight capture if the composer unmounts mid-recording.
  useEffect(() => {
    return () => {
      if (recordingRef.current) void stopCapture(false);
    };
  }, [stopCapture]);

  const canSend = !!text.trim() && !sending;
  const voiceConnecting = recording && captureStatus === "connecting";
  return (
    <div
      className="shrink-0 px-3 pt-2"
      // Lift the composer off the bottom edge. Keyboard up → float above it
      // (--kb-height, set by main.tsx); keyboard down → a base gap (≈ pb-6)
      // that also clears the home indicator (safe-area). Inline `paddingBottom`
      // would otherwise override any `pb-*` class, which is why it was hugging
      // the bottom when --kb-height resolved to 0.
      style={{
        paddingBottom:
          "max(var(--kb-height, 0px), env(safe-area-inset-bottom, 0px), 1.5rem)",
      }}
    >
      {recording ? (
        <div
          className="flex flex-col gap-2 rounded-3xl border border-foreground/[0.08] px-4 py-3"
          style={{
            background: "rgba(255,255,255,0.6)",
            backdropFilter: "blur(20px) saturate(1.5)",
            WebkitBackdropFilter: "blur(20px) saturate(1.5)",
            boxShadow: "0 4px 24px hsl(0 0% 0% / 0.04)",
          }}
        >
          <p className="flex min-h-[20px] items-center gap-1.5 text-body italic leading-snug text-foreground/55">
            {voiceConnecting && !voiceFinalizing && !voiceTranscript && (
              <Loader2 size={14} strokeWidth={2} className="shrink-0 animate-spin" />
            )}
            <span className="min-w-0 truncate">
              {voiceFinalizing
                ? "Polishing…"
                : voiceTranscript || (voiceConnecting ? "Connecting…" : "Listening…")}
            </span>
          </p>
          <div className="flex items-center gap-2.5">
            <Text variant="label" weight="medium" className="w-[40px] shrink-0 tabular-nums text-foreground/55">
              {formatRecordDuration(recordSec)}
            </Text>
            {voiceConnecting ? (
              <div className="flex min-w-0 flex-1 items-center justify-center">
                <Loader2 size={19} strokeWidth={2} className="animate-spin text-foreground/50" />
              </div>
            ) : (
              <Waveform className="flex-1" />
            )}
            <button
              type="button"
              onClick={cancelRecording}
              disabled={voiceFinalizing}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground/55 transition-colors hover:bg-foreground/10 disabled:opacity-40"
              aria-label="Cancel recording"
            >
              <X size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => void confirmRecording()}
              disabled={voiceFinalizing || voiceConnecting}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-background transition-transform active:scale-95 disabled:opacity-60"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)",
                boxShadow: "0 4px 12px hsl(var(--primary) / 0.35)",
              }}
              aria-label="Use transcript"
            >
              <Check size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      ) : (
      <div
        className="flex items-end gap-2 rounded-3xl border border-foreground/[0.08] py-2 pl-4 pr-2 transition-colors focus-within:border-foreground/[0.18]"
        style={{
          background: "rgba(255,255,255,0.6)",
          backdropFilter: "blur(20px) saturate(1.5)",
          WebkitBackdropFilter: "blur(20px) saturate(1.5)",
          boxShadow: "0 4px 24px hsl(0 0% 0% / 0.04)",
        }}
        onFocusCapture={() => onFocusChange?.(true)}
        onBlurCapture={() => onFocusChange?.(false)}
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? "Message PIN AI…"}
          rows={1}
          className="min-h-9 max-h-[120px] flex-1 resize-none bg-transparent py-2 text-body leading-[20px] text-foreground outline-none placeholder:text-foreground/35"
        />
        {kbVisible && (
          <button
            type="button"
            // preventDefault so the click doesn't blur the textarea first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (document.activeElement as HTMLElement | null)?.blur?.()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/80"
            title="Dismiss keyboard"
          >
            <ChevronDown size={18} strokeWidth={1.6} />
          </button>
        )}
        <button
          type="button"
          onClick={startRecording}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/80"
          aria-label="Voice input"
        >
          <Mic size={18} strokeWidth={1.6} />
        </button>
        {streaming ? (
          <button
            type="button"
            onClick={() => void onStop?.()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-foreground/90 text-background transition-all active:scale-95 hover:bg-foreground"
            aria-label="Stop"
            title="Stop"
          >
            <Square size={12} strokeWidth={2} fill="currentColor" />
          </button>
        ) : null}
        {streaming && !canSend ? null : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all active:scale-95"
            style={
              canSend
                ? {
                    background:
                      "linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(330 80% 65%) 100%)",
                    boxShadow: "0 4px 12px hsl(var(--primary) / 0.35)",
                    color: "hsl(var(--background))",
                  }
                : {
                    background: "hsl(var(--foreground) / 0.08)",
                    color: "hsl(var(--foreground) / 0.35)",
                  }
            }
            aria-label={streaming ? "Queue message" : "Send"}
            title={streaming ? "Queue message" : "Send"}
          >
            <Send size={15} strokeWidth={2} />
          </button>
        )}
      </div>
      )}
    </div>
  );
});
