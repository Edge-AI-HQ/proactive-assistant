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
import { AlertCircle, ArrowLeft, Check, ChevronDown, Copy, Loader2, Mic, Pencil, Radio, RotateCcw, Send, Sparkles, Square, ThumbsDown, ThumbsUp, X } from "lucide-react";
import bgGradient from "@/assets/bg-gradient.jpg";
import { cn } from "@/lib/utils";
import { notifyThreadActivity, readLocalHistory } from "@/lib/sync/sync-bootstrap";
import MarkdownContent from "@/components/chat/conversation/MarkdownContent";
import { buildAssistantMessageFeedbackBody } from "@/components/chat/conversation/feedback";
// The shared animated orb — looping video with a buffering reveal so the
// landing hero doesn't flash dark when the Ask PIN AI sheet opens.
import AiSphere from "@/components/now/AiSphere";
import { ShimmerText } from "@/components/chat/conversation/ReasoningBlock";
import WorkGroup from "@/components/chat/conversation/WorkGroup";
import { segmentAssistantParts } from "@/components/chat/conversation/work-group";
import ProposeActionCard from "@/components/chat/conversation/ProposeActionCard";
import { HitlApprovalCard, type HitlRequiresAction } from "@/components/chat/conversation/HitlApprovalCard";
import { useChatScroll, type ChatScrollApi } from "@/components/chat/conversation/scroll/useChatScroll";
import JumpToLatest from "@/components/chat/conversation/scroll/JumpToLatest";
import TodoPanel from "@/components/chat/conversation/TodoPanel";
import BrowserPanel from "@/components/browser/BrowserPanel";
import type { SheetStage } from "@/components/browser/BrowserView";
import { useBrowserSession } from "@/hooks/useBrowserSession";
import { useVoiceInput, Waveform, appendVoiceTranscript } from "@/components/voice";
import {
  useConversationRuntime,
  type ConversationAssistantEntry,
  type ConversationEntry,
  type ConversationUserEntry,
} from "@/components/chat/conversation/useConversationRuntime";
import type { ConversationContentPart } from "@/components/chat/conversation/tool-steps";
import { conversationInit, proxyPost } from "@/lib/api";

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
      <h2 className="text-display px-6 text-center text-[28px] font-semibold leading-[1.05] tracking-tight text-foreground">
        What&apos;s on your mind?
      </h2>
      <p className="mt-2 px-8 text-center text-[13px] leading-snug text-foreground/50">
        Ask anything — I have your context.
      </p>
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
            <span className="text-[13px] leading-snug text-foreground/75">{s}</span>
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

function UserEntry({
  entry,
  onRetry,
  isLast,
  onEdit,
}: {
  entry: ConversationUserEntry;
  onRetry: (id: string, text: string) => void;
  /** This is the latest user turn → show the Edit affordance. */
  isLast?: boolean;
  /** Prefill the composer with this turn's text for the user to revise and
   *  re-send as a NEW turn (the original bubble stays as-is). */
  onEdit?: (text: string) => void;
}) {
  const clockLabel = formatClockTime(entry.ts);
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="mb-4 flex flex-col items-end"
    >
      <div
        className={cn(
          "max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-foreground/90 px-4 py-2.5 text-[13px] leading-relaxed text-background",
          entry.failed && "opacity-50",
        )}
      >
        {entry.text}
      </div>
      {entry.failed ? (
        <button
          type="button"
          onClick={() => onRetry(entry.id, entry.text)}
          className="mt-1 flex items-center gap-1 text-[11px] font-medium text-red-500 transition-colors hover:text-red-600"
        >
          <AlertCircle size={11} strokeWidth={2} />
          Not sent
          <span className="text-foreground/40">·</span>
          <RotateCcw size={10} strokeWidth={2} />
          Retry
        </button>
      ) : (
        <div className="mt-1 flex items-center gap-2 pr-0.5">
          {clockLabel ? (
            <span className="text-[11px] font-medium tabular-nums text-foreground/40">
              {clockLabel}
            </span>
          ) : null}
          {isLast && onEdit ? (
            <button
              type="button"
              onClick={() => onEdit(entry.text)}
              className="flex items-center gap-1 text-[11px] font-medium text-foreground/40 transition-colors hover:text-foreground/70"
              aria-label="Edit message"
            >
              <Pencil size={12} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      )}
    </motion.div>
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
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[hsl(304_75%_45%)]">
          Notify you
        </span>
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
            <div className="inline-flex items-center -ml-2 rounded-lg px-2 py-1 text-[12.5px] font-medium text-foreground/65">
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
          <div className="inline-flex items-center -ml-2 rounded-lg px-2 py-1 text-[12.5px] font-medium text-foreground/65">
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
          <span className="text-[13px] text-foreground/40">Loading…</span>
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
            <p className="text-[13px] text-foreground/45">
              Ask the agent to act on this card, or send it a message.
            </p>
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
  kind = "proactive",
  cardContext,
  bootstrap,
  title,
  headerSlot,
  placeholder,
  onDone,
  onDismiss,
  backIcon = "down",
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
  const hasRunningTurn = transcript.some((e) => e.kind === "assistant" && e.running);
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
    setControl,
    sendInput,
    refreshLiveView,
    close: closeBrowser,
  } = useBrowserSession(browserSessionKey);
  const [browserStage, setBrowserStage] = useState<SheetStage | "closed">("closed");
  const [composerFocused, setComposerFocused] = useState(false);

  // Scroll policy (reading-first): useChatScroll owns the follow/free state
  // machine, the send anchor and the jump affordance; TranscriptView wires it
  // into Virtuoso. Sends route through anchorToSend so the new user message
  // lands at the viewport top with the reply streaming into the runway below.
  const scroll = useChatScroll({ session: sessionKey, transcript });
  const { anchorToSend } = scroll;
  const sendAndAnchor = useCallback(
    (text: string) => {
      const p = sendMessage(text); // appends the optimistic bubble synchronously
      anchorToSend();
      return p;
    },
    [sendMessage, anchorToSend],
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

  // BrowserPanel speaks (mode, x, y, dx, dy); wrap the hook's typed sendInput.
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
    (mode: "ai" | "user") => void setControl(mode),
    [setControl],
  );
  const handleBrowserClose = useCallback(() => void closeBrowser(), [closeBrowser]);

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
              <h2 className="text-display truncate text-[15px] text-foreground">
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
              <span className="text-[12px] font-medium text-foreground/55">
                Debug
              </span>
              <HeartbeatToggle
                checked={debugEnabled}
                disabled={false}
                onChange={setDebug}
              />
              <span className="ml-1 text-[12px] font-medium text-foreground/55">
                Proactive
              </span>
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
                  className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.06] disabled:opacity-40"
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
                  className="flex items-center gap-1 rounded-full bg-foreground/90 px-2.5 py-1 text-[11.5px] font-medium text-background transition-colors hover:bg-foreground disabled:opacity-40"
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

        {/* Chat region + browser top-sheet share a relative container so the
            BrowserPanel slides down from just below the header (never covering
            the back button). When the sheet is in "mini" it occupies the top
            32px; pad the chat so messages aren't clipped behind it. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            className="flex min-h-0 flex-1 flex-col"
            style={{
              paddingTop: browserStage === "mini" ? 32 : 0,
              transition: "padding-top 200ms ease-out",
            }}
          >
            {/* Transcript + the floating jump-to-latest affordance. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              <FeedbackChannelContext.Provider value={feedbackChannel}>
                <TranscriptView
                  ready={ready}
                  isProactive={isProactive}
                  transcript={transcript}
                  busy={busy}
                  hasRunningTurn={hasRunningTurn}
                  debugEnabled={debugEnabled}
                  scroll={scroll}
                  hasMoreHistory={hasMoreHistory}
                  loadMoreHistory={loadMoreHistory}
                  sendMessage={sendAndAnchor}
                  retryMessage={retryAndAnchor}
                  onEdit={handleEditEntry}
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

            {/* Footer: agent plan + composer. The HITL approval gate renders
                inline on the paused turn (TranscriptView), not here. */}
            <div className="relative shrink-0">
              <TodoPanel sessionKey={browserSessionKey} composerFocused={composerFocused} />
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
    if (!trimmed || sending || streaming) return;
    setText("");
    setSending(true);
    try {
      await onSend(trimmed);
    } catch (err) {
      console.warn("[proactive] send failed:", err);
    } finally {
      setSending(false);
    }
  }, [text, sending, streaming, onSend]);

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
          <p className="flex min-h-[20px] items-center gap-1.5 text-[14px] italic leading-snug text-foreground/55">
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
            <span className="w-[40px] shrink-0 text-[12px] font-medium tabular-nums text-foreground/55">
              {formatRecordDuration(recordSec)}
            </span>
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
                  "linear-gradient(135deg, hsl(292 78% 63%) 0%, hsl(330 80% 65%) 100%)",
                boxShadow: "0 4px 12px hsl(292 78% 63% / 0.35)",
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
          className="min-h-9 max-h-[120px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-[20px] text-foreground outline-none placeholder:text-foreground/35"
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
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all active:scale-95"
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
        )}
      </div>
      )}
    </div>
  );
});
