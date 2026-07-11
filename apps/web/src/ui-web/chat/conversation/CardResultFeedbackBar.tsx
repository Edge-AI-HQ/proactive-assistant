import { useCallback, useState } from "react";
import { Check, Loader2, MessageSquarePlus, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { buildAssistantMessageFeedbackBody, proxyPost } from "@pin-ai/core";
import { Text } from "../../primitives/Text";

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
export function CardResultFeedbackBar({
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
  const { t } = useTranslation(["chat", "common"]);
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
          {t("cardFeedback.helpfulPrompt")}
        </Text>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => sendThumbs("up")}
            disabled={!messageId}
            aria-label={t("cardFeedback.helpful")}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${feedback === "up" ? "bg-green-500/20 text-green-600" : "bg-foreground/5 text-foreground/55 hover:bg-foreground/10"}`}
          >
            <ThumbsUp size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => sendThumbs("down")}
            disabled={!messageId}
            aria-label={t("cardFeedback.notHelpful")}
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
                <Check size={12} strokeWidth={2.5} /> {t("cardFeedback.sent")}
              </>
            ) : (
              <>
                <MessageSquarePlus size={12} strokeWidth={2} /> {t("cardFeedback.comment")}
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
            {t("common:status.done")}
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
            placeholder={t("cardFeedback.commentPlaceholder")}
            className="h-9 flex-1 rounded-full border border-foreground/10 bg-white/60 px-4 text-bodySm text-foreground placeholder:text-foreground/35 focus:outline-none"
          />
          <button
            type="button"
            onClick={submitComment}
            disabled={!commentText.trim()}
            aria-label={t("cardFeedback.sendFeedback")}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
          >
            <Send size={14} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
}
