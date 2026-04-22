/**
 * Action bar rendered under each message.
 *
 * Layout stays stable: the bar reserves its height unconditionally and uses
 * opacity for hover reveal, so hovering an older message never pushes later
 * messages around (Claude-style behaviour).
 *
 * Icons only; the text label moves to `title`/`aria-label` for accessibility
 * and native tooltips.
 *
 * Assistant messages get Copy + relative timestamp, user messages get Copy
 * only. Retry/Edit are both disabled: the OpenClaw subagent runtime does not
 * support replace-and-rerun semantics, so exposing them would be a broken
 * affordance.
 */
import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import {
  ActionBarPrimitive,
  MessagePrimitive,
  useMessage,
} from "@assistant-ui/react";
import { cn } from "@/lib/utils";

type Variant = "assistant" | "user";

interface Props {
  variant: Variant;
}

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

const ICON_BUTTON_CLASS = cn(
  "inline-flex items-center justify-center w-6 h-6 rounded",
  "text-foreground/45 hover:text-foreground/80 hover:bg-foreground/5",
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
        <Copy size={13} strokeWidth={1.8} />
      </MessagePrimitive.If>
    </ActionBarPrimitive.Copy>
  );
}

export default function MessageActionBar({ variant }: Props) {
  const isAssistant = variant === "assistant";
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      className={cn(
        // Always visible — matches Claude iOS, and touch devices don't reliably
        // fire :hover so gating by hover would make the button flicker as
        // messages scroll in and out of the "last" slot.
        "mt-1 flex items-center h-7",
        !isAssistant && "justify-end",
      )}
    >
      <CopyButton />
      {isAssistant && (
        <div className="ml-auto pr-0.5">
          <RelativeTimestamp />
        </div>
      )}
    </ActionBarPrimitive.Root>
  );
}
