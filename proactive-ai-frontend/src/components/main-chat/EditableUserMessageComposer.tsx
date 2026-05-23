import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type KeyboardEvent,
} from "react";

interface EditableUserMessageComposerProps {
  initialText: string;
  disabled?: boolean;
  onDraftChange: (draft: string) => void;
  onCancel: () => void;
  onSend: (draft: string) => void;
}

export function EditableUserMessageComposer({
  initialText,
  disabled = false,
  onDraftChange,
  onCancel,
  onSend,
}: EditableUserMessageComposerProps) {
  const [draft, setDraft] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(initialText);
  }, [initialText]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
  }, [draft]);

  const updateDraft = useCallback(
    (nextDraft: string) => {
      setDraft(nextDraft);
      onDraftChange(nextDraft);
    },
    [onDraftChange],
  );

  const submit = useCallback(() => {
    if (disabled || !draft.trim()) return;
    onSend(draft);
  }, [disabled, draft, onSend]);

  const handleBubbleMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("button") || target === textareaRef.current) return;
      event.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const canSend = !disabled && !!draft.trim();

  return (
    <div
      data-testid="user-edit-composer"
      className="max-w-[82%] w-full px-3.5 py-2.5 rounded-2xl rounded-br-md bg-foreground/90 text-background flex flex-col gap-2"
      onMouseDown={handleBubbleMouseDown}
    >
      <textarea
        ref={textareaRef}
        aria-label="Edit message text"
        autoFocus
        rows={1}
        value={draft}
        onChange={(event) => updateDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full resize-none bg-transparent outline-none text-[13px] leading-relaxed text-background placeholder:text-background/45 min-h-[20px]"
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] font-medium px-2.5 py-1 rounded-md text-background/70 hover:text-background hover:bg-background/10 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-background/20 text-background hover:bg-background/30 transition-colors disabled:opacity-50 disabled:hover:bg-background/20"
        >
          Save &amp; Send
        </button>
      </div>
    </div>
  );
}
