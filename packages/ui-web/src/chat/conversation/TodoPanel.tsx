/**
 * Collapsible plan panel rendered above the chat composer.
 *
 * Reads the TURN-SCOPED plan from todos-store (keyed by sessionKey). The
 * agent's write_todos updates it during a turn; chat:done retires it:
 * fully-completed plans linger briefly as a "Plan done" beat, unfinished
 * ones (cancelled / errored turns) hide immediately — either way the panel
 * never haunts the next conversation. The next turn's first write_todos
 * starts a fresh plan.
 *
 * Per-turn interaction state:
 *   - dismissed (X): silences THIS turn's plan only; a new turn resurfaces.
 *   - expanded: reset on a new turn's plan; later updates within the same
 *     turn keep the user's choice (no more re-expanding on every update).
 *     Composer focus still collapses it so the keyboard gets the height.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Circle, Loader2, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTodoPlan, type Todo } from "@pin-ai/state";

interface TodoPanelProps {
  sessionKey: string;
  composerFocused: boolean;
}

/** How long a fully-completed plan stays visible after its turn ends. */
const DONE_LINGER_MS = 2000;

function statusIcon(status: Todo["status"]) {
  if (status === "completed") {
    return <Check size={14} strokeWidth={2.4} className="text-emerald-600" />;
  }
  if (status === "in_progress") {
    return <Loader2 size={14} strokeWidth={2} className="animate-spin text-blue-500" />;
  }
  return <Circle size={14} strokeWidth={2} className="text-foreground/30" />;
}

export default function TodoPanel({ sessionKey, composerFocused }: TodoPanelProps) {
  const plan = useTodoPlan(sessionKey);
  const [expanded, setExpanded] = useState(true);
  const [dismissedTurnId, setDismissedTurnId] = useState<string | null>(null);
  const [retired, setRetired] = useState(false);
  const seenTurnRef = useRef<string | null>(null);
  const lingerRef = useRef<number | null>(null);

  const turnId = plan?.turnId ?? null;
  const completed = plan ? plan.todos.filter((t) => t.status === "completed").length : 0;
  const allDone = plan ? completed === plan.todos.length && plan.todos.length > 0 : false;

  // Focus mirrored into a ref: the turn-boundary effect reads it once
  // without depending on it (live focus → collapse is the next effect's job).
  const composerFocusedRef = useRef(composerFocused);
  useEffect(() => {
    composerFocusedRef.current = composerFocused;
  }, [composerFocused]);

  // A NEW turn's plan resets the per-turn interaction state and resurfaces
  // the panel; later write_todos updates within the same turn change nothing
  // here (the user's collapse/dismiss choices stick).
  useEffect(() => {
    if (turnId === null || seenTurnRef.current === turnId) return;
    seenTurnRef.current = turnId;
    setRetired(false);
    setExpanded(!composerFocusedRef.current);
    setDismissedTurnId(null);
  }, [turnId]);

  // Composer focus → collapse so the typing area gets the height. Blur
  // alone does not auto-expand; the next turn's plan does.
  useEffect(() => {
    if (composerFocused) setExpanded(false);
  }, [composerFocused]);

  // Turn finished → retire the plan. Fully-done plans linger briefly so the
  // user sees the ✓ beat; unfinished ones hide immediately.
  useEffect(() => {
    if (!plan?.done || retired) return;
    if (!allDone) {
      setRetired(true);
      return;
    }
    if (lingerRef.current !== null) return;
    lingerRef.current = window.setTimeout(() => {
      lingerRef.current = null;
      setRetired(true);
    }, DONE_LINGER_MS);
    return () => {
      if (lingerRef.current !== null) {
        window.clearTimeout(lingerRef.current);
        lingerRef.current = null;
      }
    };
  }, [plan?.done, allDone, retired]);

  if (!plan || plan.todos.length === 0 || retired) return null;
  if (dismissedTurnId !== null && dismissedTurnId === plan.turnId) return null;

  return (
    <div className="mx-2 mb-1 rounded-xl border border-foreground/10 bg-white/70 backdrop-blur-sm shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[13px] font-medium text-foreground/80">
          {plan.done && allDone ? "Plan done" : "Plan"}
        </span>
        <span
          className={cn(
            "text-[12px]",
            allDone ? "text-emerald-600" : "text-foreground/45",
          )}
        >
          · {completed}/{plan.todos.length} done
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse plan" : "Expand plan"}
            className="p-1 rounded-md text-foreground/50 hover:text-foreground/80 hover:bg-foreground/10 transition-colors"
          >
            <ChevronDown
              size={14}
              strokeWidth={2.2}
              className={cn(
                "transition-transform duration-200",
                expanded ? "rotate-0" : "-rotate-90",
              )}
            />
          </button>
          <button
            type="button"
            onClick={() => setDismissedTurnId(plan.turnId)}
            aria-label="Close plan"
            className="p-1 rounded-md text-foreground/50 hover:text-foreground/80 hover:bg-foreground/10 transition-colors"
          >
            <X size={14} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {expanded && (
        <ul className="max-h-[200px] overflow-y-auto px-3 pb-2 pt-0.5 space-y-1.5">
          {plan.todos.map((todo, i) => (
            <li
              key={`${i}-${todo.content}`}
              className="flex items-start gap-2 text-[13px] leading-snug"
            >
              <span className="mt-0.5 shrink-0">{statusIcon(todo.status)}</span>
              <span
                className={cn(
                  "flex-1",
                  todo.status === "completed"
                    ? "text-foreground/40 line-through"
                    : todo.status === "in_progress"
                      ? "text-foreground/90"
                      : "text-foreground/65",
                )}
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
