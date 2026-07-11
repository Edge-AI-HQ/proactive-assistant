import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Pencil, Send, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConversationUserEntry } from "@pin-ai/core";
import { Text } from "../../primitives/Text";
import { ACTION_BTN } from "./_shared";

export function QueuedMessagesPanel({
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
  const { t } = useTranslation("chat");
  if (entries.length === 0) return null;
  return (
    <div className="px-8">
      <div
        role="region"
        aria-label={t("queued.regionLabel")}
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
  const { t } = useTranslation(["chat", "common"]);
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
              aria-label={t("queued.saveAria")}
              title={t("queued.save")}
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
              aria-label={t("queued.cancelEditAria")}
              title={t("common:status.cancel")}
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
              aria-label={t("queued.editAria")}
              title={t("queued.edit")}
            >
              <Pencil size={13} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={sendNow}
              disabled={busy !== null}
              className={ACTION_BTN}
              aria-label={t("queued.sendNow")}
              title={t("queued.sendNow")}
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
              aria-label={t("queued.deleteAria")}
              title={t("queued.delete")}
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
