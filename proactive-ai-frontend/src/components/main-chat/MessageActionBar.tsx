/**
 * Action bar rendered under each message.
 *
 * Reads the message via `useMessage`, the thread via `useAuiState` for
 * "is this the last user/assistant message" gating, and the thread
 * runtime for Retry / Regenerate actions (which both reduce to a
 * `startRun(parentId=userMsgId)` — assistant-ui drops the trailing
 * messages and re-invokes the adapter, which then signals
 * `regenerate=true` to the backend).
 *
 * User-message variant:
 *   - absolute HH:MM AM/PM timestamp
 *   - Retry (only on the last user message)
 *   - Edit (prefills the composer with this message's text; the actual
 *     edit is then up to the user — submitting it from the composer
 *     appends a NEW user turn, the original stays as-is)
 *   - Copy
 *
 * Assistant-message variant:
 *   - Copy
 *   - ThumbsUp / ThumbsDown (posts unified feedback events)
 *   - Regenerate (only on the last assistant message)
 */
import { useMemo, useState } from "react";
import { Copy, Check, RotateCcw, Pencil, ThumbsUp, ThumbsDown } from "lucide-react";
import {
  ActionBarPrimitive,
  MessagePrimitive,
  useMessage,
  useThreadRuntime,
} from "@assistant-ui/react";
import { useAuiState } from "@assistant-ui/store";
import { proxyPost } from "@/lib/api";
import { cn } from "@/lib/utils";

type Variant = "assistant" | "user";
type AssistantFeedback = "up" | "down";

interface Props {
  variant: Variant;
}

export function buildAssistantMessageFeedbackBody(
  messageId: string,
  feedback: AssistantFeedback | null,
): Record<string, unknown> | null {
  if (!feedback) return null;
  return {
    kind: "chat_message_feedback",
    action: feedback === "up" ? "thumbs_up" : "thumbs_down",
    messageId,
    channel: "main_chat",
    metadata: {
      surface: "assistant_message_action_bar",
    },
  };
}

function formatClockTime(createdAt: Date | undefined): string | null {
  if (!createdAt) return null;
  const ms = createdAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  let h = createdAt.getHours();
  const m = createdAt.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

const ICON_BUTTON_CLASS = cn(
  "inline-flex items-center justify-center w-7 h-7 rounded-lg",
  "text-foreground/45 hover:text-foreground/75 hover:bg-foreground/[0.06]",
  "transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default",
);

const ICON_BUTTON_ACTIVE_CLASS = cn(
  "inline-flex items-center justify-center w-7 h-7 rounded-lg",
  "text-foreground bg-foreground/[0.08]",
  "transition-colors",
);

function CopyButton() {
  return (
    <ActionBarPrimitive.Copy
      className={ICON_BUTTON_CLASS}
      title="Copy"
      aria-label="Copy message"
    >
      <MessagePrimitive.If copied>
        <Check size={13} strokeWidth={2} className="text-emerald-500" />
      </MessagePrimitive.If>
      <MessagePrimitive.If copied={false}>
        <Copy size={13} strokeWidth={1.6} />
      </MessagePrimitive.If>
    </ActionBarPrimitive.Copy>
  );
}

function useLastUserMessageId(): string | null {
  return useAuiState((s) => {
    const msgs = s.thread.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") return msgs[i].id;
    }
    return null;
  });
}

function useLastAssistantMessageId(): string | null {
  return useAuiState((s) => {
    const msgs = s.thread.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") return msgs[i].id;
    }
    return null;
  });
}

/**
 * Locate the user message that should serve as parentId for a
 * Regenerate operation on the given assistant id: it's the message
 * immediately preceding the assistant in the thread.
 *
 * Returns null if the assistant has no preceding user msg (extreme
 * edge case — would only happen on a malformed thread).
 */
function useParentUserIdForAssistant(assistantId: string): string | null {
  return useAuiState((s) => {
    const msgs = s.thread.messages;
    const idx = msgs.findIndex((m) => m.id === assistantId);
    if (idx <= 0) return null;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === "user") return msgs[i].id;
    }
    return null;
  });
}

export default function MessageActionBar({ variant }: Props) {
  return variant === "assistant" ? <AssistantActionBar /> : <UserActionBar />;
}

function UserActionBar() {
  const messageId = useMessage((m) => m.id);
  const createdAt = useMessage((m) => m.createdAt);
  const lastUserId = useLastUserMessageId();
  const isLastUser = lastUserId === messageId;

  const threadRuntime = useThreadRuntime();
  const isRunning = useAuiState((s) => s.thread.isRunning);

  const clockLabel = useMemo(() => formatClockTime(createdAt), [createdAt]);

  const handleRetry = () => {
    if (isRunning) return;
    // Retry on a user msg = same as Regenerate on the assistant that
    // follows it. assistant-ui's startRun(parentId=user) drops the
    // trailing assistant + tools and re-invokes the adapter. The adapter
    // detects via lastSeenMessageCountRef that the runtime didn't grow
    // since last send → signals regenerate=true to the backend, which
    // pops the stale AIMessage from LangGraph state.
    threadRuntime.startRun({
      parentId: messageId,
      sourceId: null,
      runConfig: {},
    });
  };

  return (
    // Timestamp lives OUTSIDE ActionBarPrimitive.Root so it stays visible while
    // the agent is running — only the action buttons (Retry/Edit/Copy) are
    // gated by `hideWhenRunning`. (Previously the timestamp sat inside Root and
    // vanished on every turn while the assistant streamed, then reappeared.)
    <div className="mt-1 flex items-center gap-0.5 pr-0.5 justify-end">
      {clockLabel && (
        <span className="text-[11px] font-medium tabular-nums text-foreground/45 mr-1.5">
          {clockLabel}
        </span>
      )}
      <ActionBarPrimitive.Root
        hideWhenRunning
        className="flex items-center gap-0.5"
      >
        {isLastUser && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={isRunning}
            className={ICON_BUTTON_CLASS}
            title="Retry"
            aria-label="Retry"
          >
            <RotateCcw size={13} strokeWidth={1.6} />
          </button>
        )}
        {isLastUser && (
          <ActionBarPrimitive.Edit
            className={ICON_BUTTON_CLASS}
            title="Edit"
            aria-label="Edit message"
          >
            <Pencil size={13} strokeWidth={1.6} />
          </ActionBarPrimitive.Edit>
        )}
        <CopyButton />
      </ActionBarPrimitive.Root>
    </div>
  );
}

function AssistantActionBar() {
  const messageId = useMessage((m) => m.id);
  const lastAssistantId = useLastAssistantMessageId();
  const isLastAssistant = lastAssistantId === messageId;

  const parentUserId = useParentUserIdForAssistant(messageId);
  const threadRuntime = useThreadRuntime();
  const isRunning = useAuiState((s) => s.thread.isRunning);

  const [feedback, setFeedback] = useState<AssistantFeedback | null>(null);

  const handleRegenerate = () => {
    if (isRunning || !parentUserId) return;
    threadRuntime.startRun({
      parentId: parentUserId,
      sourceId: null,
      runConfig: {},
    });
  };

  const handleFeedback = (next: AssistantFeedback) => {
    const effective = feedback === next ? null : next;
    setFeedback(effective);
    const body = buildAssistantMessageFeedbackBody(messageId, effective);
    if (!body) return;
    void proxyPost("/feedback", body).catch(() => {
      // Feedback persistence is best-effort; keep the local reaction responsive.
    });
  };

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      className="mt-1 flex items-center gap-0.5 pl-0.5"
    >
      <CopyButton />
      <button
        type="button"
        onClick={() => handleFeedback("up")}
        className={
          feedback === "up" ? ICON_BUTTON_ACTIVE_CLASS : ICON_BUTTON_CLASS
        }
        title="Good response"
        aria-label="Good response"
      >
        <ThumbsUp
          size={13}
          strokeWidth={1.6}
          fill={feedback === "up" ? "currentColor" : "none"}
        />
      </button>
      <button
        type="button"
        onClick={() => handleFeedback("down")}
        className={
          feedback === "down" ? ICON_BUTTON_ACTIVE_CLASS : ICON_BUTTON_CLASS
        }
        title="Bad response"
        aria-label="Bad response"
      >
        <ThumbsDown
          size={13}
          strokeWidth={1.6}
          fill={feedback === "down" ? "currentColor" : "none"}
        />
      </button>
      {isLastAssistant && (
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={isRunning || !parentUserId}
          className={ICON_BUTTON_CLASS}
          title="Regenerate"
          aria-label="Regenerate"
        >
          <RotateCcw size={13} strokeWidth={1.6} />
        </button>
      )}
    </ActionBarPrimitive.Root>
  );
}
