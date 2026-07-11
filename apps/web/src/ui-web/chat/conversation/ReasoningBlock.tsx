/**
 * Collapsed-by-default extended-thinking block for assistant messages.
 *
 * Two-state visual:
 *   - `shimmer=true`  → the whole assistant turn is still streaming;
 *                       label sweeps in a Claude-style gradient so the
 *                       user knows the system is still working
 *   - `shimmer=false` → turn complete; label is static
 *
 * Two-state label:
 *   - `appending=true`             → "Thinking…" (reasoning text is
 *                                    still being appended to this part)
 *   - `appending=false`, has dur   → "Thought for Xs" (we sealed the
 *                                    duration the instant another part
 *                                    came after this reasoning)
 *   - otherwise                    → "Thought process" (legacy state,
 *                                    rare — reasoning visible but we
 *                                    never observed an appending→done
 *                                    transition)
 *
 * The split lets shimmer keep running until the LLM finishes the whole
 * reply (matches the v3 / Claude UX) while the duration accurately
 * reflects only the thinking phase.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import MarkdownContent from "./MarkdownContent";

interface Props {
  text: string;
  /** Whole-message is still running. Drives the shimmer animation. */
  shimmer?: boolean;
  /** This reasoning part is still being appended to (it's the last
   *  content part of the assistant message). Used to detect the moment
   *  reasoning is "done" so we can freeze `durationSec`. */
  appending?: boolean;
}

export default function ReasoningBlock({
  text,
  shimmer = false,
  appending = false,
}: Props) {
  const { t } = useTranslation(["chat", "common"]);
  const [open, setOpen] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);

  useEffect(() => {
    if (appending && startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    } else if (!appending && startedAtRef.current !== null && durationSec === null) {
      const elapsed = Math.max(
        1,
        Math.round((Date.now() - startedAtRef.current) / 1000),
      );
      setDurationSec(elapsed);
    }
  }, [appending, durationSec]);

  if (!text && !shimmer) return null;

  const canExpand = !!text;
  const label = appending
    ? t("common:status.thinking")
    : durationSec !== null
      ? t("reasoning.thoughtForSeconds", { seconds: durationSec })
      : t("reasoning.thoughtProcess");

  return (
    <div className="mb-2 select-text">
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        disabled={!canExpand}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-2 py-1 -ml-2 rounded-lg text-label font-medium transition-colors ${
          canExpand
            ? "text-foreground/65 hover:text-foreground hover:bg-foreground/[0.04] cursor-pointer"
            : "cursor-default text-foreground/65"
        }`}
      >
        {shimmer ? <ShimmerText>{label}</ShimmerText> : <span>{label}</span>}
        {canExpand && (
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={`text-foreground/45 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && text && (
          <motion.div
            key="thinking-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 pl-3 border-l-2 border-foreground/10">
              <MarkdownContent text={text} muted />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Claude-style shimmer label — a subtle gradient sweeps across the text
 * to convey "in progress" without an icon or spinner.
 *
 * Exported so the very-first-token-pending state in ConversationView's
 * AssistantMessage can reuse the same visual.
 */
export function ShimmerText({ children }: { children: ReactNode }) {
  return (
    <motion.span
      className="bg-clip-text text-transparent"
      style={{
        backgroundImage:
          "linear-gradient(90deg, hsl(var(--foreground) / 0.32) 0%, hsl(var(--foreground) / 0.32) 35%, hsl(var(--foreground) / 0.95) 50%, hsl(var(--foreground) / 0.32) 65%, hsl(var(--foreground) / 0.32) 100%)",
        backgroundSize: "200% 100%",
        WebkitBackgroundClip: "text",
      }}
      animate={{ backgroundPosition: ["100% 50%", "-100% 50%"] }}
      transition={{ duration: 2.4, repeat: Infinity, ease: "linear" }}
    >
      {children}
    </motion.span>
  );
}
