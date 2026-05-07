/**
 * Collapsed-by-default extended-thinking block for assistant messages.
 *
 * Receives `{ text, status }` from assistant-ui's `Reasoning` slot in
 * `MessagePrimitive.Content`. Streams in incrementally via the same part
 * cursor as text (see LiveContentBuilder.appendReasoning). Stays muted /
 * compact so the answer text remains the dominant visual element.
 */
import { useState } from "react";
import { ChevronRight, Brain } from "lucide-react";
import type { ReasoningMessagePartProps } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

export default function ReasoningBlock({ text, status }: ReasoningMessagePartProps) {
  const [open, setOpen] = useState(false);
  const streaming = status?.type === "running";

  if (!text && !streaming) return null;

  return (
    <div className="mb-2 select-text">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 text-[12px] text-foreground/45 hover:text-foreground/65 transition-colors",
          streaming && "animate-pulse",
        )}
      >
        <Brain className="w-3 h-3" />
        <span>{streaming ? "Thinking…" : "Thought process"}</span>
        <ChevronRight
          className={cn(
            "w-3 h-3 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && text && (
        <div className="mt-1.5 pl-4 border-l-2 border-foreground/10 text-[13px] leading-[1.55] text-foreground/55 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
