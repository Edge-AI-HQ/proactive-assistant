import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { ReasoningMessagePartComponent } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

/**
 * Renders Claude extended-thinking content as a collapsible block.
 *
 * The proactive-ai backend streams thinking deltas as `chat:reasoning:delta`
 * SSE events; useProactiveChatRuntime feeds them into LiveContentBuilder
 * which produces `{ type: "reasoning", text }` content parts. assistant-ui
 * routes those parts to the `Reasoning` slot on MessagePrimitive.Content.
 *
 * Visual style mirrors Claude Code / ChatGPT extended-thinking UI:
 *   - Muted gray italic body
 *   - Auto-expands while streaming so user sees the model think
 *   - Collapses by default once final text arrives, click to re-expand
 */
const ReasoningContent: ReasoningMessagePartComponent = ({ text, status }) => {
  const isStreaming = status?.type === "running";
  const [open, setOpen] = useState(true);

  // Auto-collapse once reasoning finishes streaming, but only on the
  // first transition — user can re-open afterwards.
  // (Initial state is open=true; once streaming flips to false we collapse
  // unless the user has already toggled.)
  const [userToggled, setUserToggled] = useState(false);
  if (!isStreaming && open && !userToggled) {
    setOpen(false);
  }

  if (!text) return null;

  return (
    <div className="mb-3 rounded-md border border-foreground/10 bg-foreground/[0.03]">
      <button
        type="button"
        onClick={() => {
          setUserToggled(true);
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-foreground/60 hover:bg-foreground/[0.04]"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            open && "rotate-90"
          )}
        />
        <span>{isStreaming ? "Thinking…" : "Thoughts"}</span>
        {isStreaming && (
          <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-foreground/30" />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-foreground/10 px-3 py-2 text-[14px] italic leading-[1.6] text-foreground/55 whitespace-pre-wrap">
              {text}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ReasoningContent;
