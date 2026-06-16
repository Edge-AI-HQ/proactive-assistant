import { memo, useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, Check, Copy, Loader2, Pencil, RotateCcw, Send, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConversationUserEntry } from "@pin-ai/core";
import { cn } from "../../lib/utils";
import { Text } from "../../primitives/Text";
import { ACTION_BTN, formatClockTime } from "./_shared";

export const UserEntry = memo(function UserEntry({
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
  const { t } = useTranslation(["chat", "common"]);
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
          {t("userEntry.notSent")}
          <span className="text-foreground/40">·</span>
          <RotateCcw size={10} strokeWidth={2} />
          {t("common:status.retry")}
        </button>
      ) : (
        <div className="mt-1 flex items-center gap-1 pr-0.5">
          {isQueued ? (
            <Text variant="caption" weight="medium" className="mr-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-foreground/45">
              {t("queued.badge")}
            </Text>
          ) : clockLabel ? (
            <Text variant="caption" weight="medium" className="tabular-nums text-foreground/40">
              {clockLabel}
            </Text>
          ) : null}
          {!isQueued ? (
            <button type="button" onClick={copy} className={ACTION_BTN} aria-label={t("actionBar.copyMessage")} title={t("actionBar.copy")}>
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
                aria-label={t("queued.saveAria")}
                title={t("queued.save")}
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
                aria-label={t("queued.cancelEditAria")}
                title={t("common:status.cancel")}
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
                aria-label={t("queued.editAria")}
                title={t("queued.edit")}
              >
                <Pencil size={13} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                onClick={sendQueuedNow}
                disabled={queueBusy !== null}
                className={ACTION_BTN}
                aria-label={t("queued.sendNow")}
                title={t("queued.sendNow")}
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
                aria-label={t("queued.deleteAria")}
                title={t("queued.delete")}
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
              aria-label={t("userEntry.editMessage")}
              title={t("queued.edit")}
            >
              <Pencil size={13} strokeWidth={1.8} />
            </button>
          ) : null}
        </div>
      )}
    </motion.div>
  );
});
