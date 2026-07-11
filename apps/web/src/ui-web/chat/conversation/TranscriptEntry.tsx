import { memo } from "react";
import type { ConversationEntry } from "@pin-ai/core";
import type { HitlRequiresAction } from "./HitlApprovalCard";
import { UserEntry } from "./UserEntry";
import { AssistantEntry } from "./AssistantEntry";

export const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  onReply,
  onRetry,
  onUpdateQueued,
  onDeleteQueued,
  onInterruptQueued,
  busy,
  hitlAction,
  onDecide,
}: {
  entry: ConversationEntry;
  onReply: (text: string) => Promise<void>;
  onRetry: (id: string, text: string) => void;
  onUpdateQueued: (id: string, text: string) => Promise<void>;
  onDeleteQueued: (id: string) => Promise<void>;
  onInterruptQueued: (id: string) => Promise<void>;
  busy: boolean;
  /** Set on the paused HITL turn's entry only (see TranscriptView). */
  hitlAction?: HitlRequiresAction | null;
  onDecide?: (decision: "approve" | "reject", message?: string) => void;
}) {
  if (entry.kind === "user")
    return (
      <UserEntry
        entry={entry}
        onRetry={onRetry}
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
      hitlAction={hitlAction}
      onDecide={onDecide}
    />
  );
});
