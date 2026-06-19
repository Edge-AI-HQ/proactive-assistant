import { memo, useCallback, useContext, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Check, Copy, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  buildAssistantMessageFeedbackBody,
  proxyPost,
  segmentAssistantParts,
  type ConversationAssistantEntry,
} from "@pin-ai/core";
import MarkdownContent from "./MarkdownContent";
import WorkGroup from "./WorkGroup";
import ProposeActionCard from "./ProposeActionCard";
import { HitlApprovalCard, type HitlRequiresAction } from "./HitlApprovalCard";
import { ShimmerText } from "./ReasoningBlock";
import { Text } from "../../primitives/Text";
import {
  ACTION_BTN,
  ACTION_BTN_ACTIVE,
  FeedbackChannelContext,
  assistantPlainText,
  notifyUserText,
} from "./_shared";

/** Action bar under a finalized assistant turn: Copy + 👍/👎 + Regenerate(last
 *  only). Thumbs write `pai_feedback_events` keyed by the backend
 *  pai_chat_messages id, so they only render once the entry carries a real
 *  (numeric) id — a live turn adopts it via the `chat:persisted` frame moments
 *  after chat:done; history turns already load with it. */
function AssistantActionBar({
  messageId,
  plainText,
}: {
  messageId: string;
  plainText: string;
}) {
  const { t } = useTranslation("chat");
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
        <button type="button" onClick={copy} className={ACTION_BTN} aria-label={t("actionBar.copyMessage")} title={t("actionBar.copy")}>
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
            aria-label={t("actionBar.goodResponse")}
            title={t("actionBar.goodResponse")}
          >
            <ThumbsUp size={13} strokeWidth={1.6} fill={feedback === "up" ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            onClick={() => sendFeedback("down")}
            className={feedback === "down" ? ACTION_BTN_ACTIVE : ACTION_BTN}
            aria-label={t("actionBar.badResponse")}
            title={t("actionBar.badResponse")}
          >
            <ThumbsDown size={13} strokeWidth={1.6} fill={feedback === "down" ? "currentColor" : "none"} />
          </button>
        </>
      ) : null}
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
  const { t } = useTranslation("chat");
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
          {t("notify.label")}
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
export const AssistantEntry = memo(function AssistantEntry({
  entry,
  onReply,
  busy,
  hitlAction,
  onDecide,
}: {
  entry: ConversationAssistantEntry;
  /** Wired to the runtime's sendMessage for propose_action replies. */
  onReply: (text: string) => Promise<void>;
  /** A turn is currently streaming on this thread. */
  busy: boolean;
  /** This turn paused on a HITL approval → render the gate where the
   *  stream stopped (after the turn's streamed parts). */
  hitlAction?: HitlRequiresAction | null;
  onDecide?: (decision: "approve" | "reject", message?: string) => void;
}) {
  const { t } = useTranslation("common");
  const { parts, running } = entry;
  const segments = segmentAssistantParts(parts);
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
  // First-token-pending: turn is running but nothing has streamed yet. A HITL
  // pause isn't "thinking", so it doesn't show the pill either.
  const showThinkingPill = running && parts.length === 0 && !showHitl;
  // Nothing to render (no blocks, no pill, no gate) → render nothing.
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
              <ShimmerText>{t("status.thinking")}</ShimmerText>
            </div>
          </div>
        ) : (
          <>
            {blocks}
            {!running ? (
              <AssistantActionBar
                messageId={entry.serverId ?? ""}
                plainText={assistantPlainText(parts)}
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
});
