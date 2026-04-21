/**
 * Action bar rendered under each assistant message.
 * Copy (with transient "Copied" state), Retry, and a live relative timestamp.
 */
import { useEffect, useState } from "react";
import { Copy, Check, RotateCcw } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ActionBarPrimitive,
  MessagePrimitive,
  useMessage,
} from "@assistant-ui/react";
import { cn } from "@/lib/utils";

function formatTimestamp(createdAt: Date | undefined): string | null {
  if (!createdAt) return null;
  const ms = createdAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const diffMs = Date.now() - ms;
  if (diffMs < 30_000) return "just now";
  return `${formatDistanceToNowStrict(createdAt)} ago`;
}

function RelativeTimestamp() {
  const createdAt = useMessage((m) => m.createdAt);
  const [label, setLabel] = useState<string | null>(() =>
    formatTimestamp(createdAt),
  );

  useEffect(() => {
    setLabel(formatTimestamp(createdAt));
    const id = setInterval(() => {
      setLabel(formatTimestamp(createdAt));
    }, 30_000);
    return () => clearInterval(id);
  }, [createdAt]);

  if (!label) return null;
  return <span className="text-[11px] text-foreground/35">{label}</span>;
}

const ACTION_BUTTON_CLASS = cn(
  "flex items-center gap-1 px-1.5 py-0.5 rounded",
  "text-[11px] text-foreground/45 hover:text-foreground/75 hover:bg-foreground/5",
  "transition-colors",
);

export default function MessageActionBar() {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="mt-1.5 flex items-center gap-1"
    >
      <ActionBarPrimitive.Copy className={ACTION_BUTTON_CLASS}>
        <MessagePrimitive.If copied>
          <Check size={12} strokeWidth={2} className="text-emerald-500" />
          <span>Copied</span>
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <Copy size={12} strokeWidth={1.8} />
          <span>Copy</span>
        </MessagePrimitive.If>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload className={ACTION_BUTTON_CLASS}>
        <RotateCcw size={12} strokeWidth={1.8} />
        <span>Retry</span>
      </ActionBarPrimitive.Reload>
      <div className="ml-auto pr-0.5">
        <RelativeTimestamp />
      </div>
    </ActionBarPrimitive.Root>
  );
}
