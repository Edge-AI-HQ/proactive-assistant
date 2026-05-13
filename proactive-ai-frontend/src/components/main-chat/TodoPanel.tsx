/**
 * Collapsible plan panel rendered above the chat composer.
 *
 * Reads from the module-level todos-store, keyed by sessionKey. When the
 * agent calls `write_todos`, useProactiveChatRuntime's SSE handler writes
 * the full plan into the store; this panel subscribes via useSyncExternalStore
 * and re-renders. Read-only — users can't edit, only the agent can.
 *
 * Three-state visibility:
 *   - dismissed: panel completely hidden (user clicked X). Next write_todos
 *     clears this state so a fresh plan resurfaces.
 *   - collapsed: only the header row ("Plan · X/Y done") is visible.
 *     Reached by the user clicking the chevron, or automatically when the
 *     composer takes focus (mobile keyboard up).
 *   - expanded: header + full todo list (max-h-[200px], scrollable).
 *
 * Body caps at max-h-[200px] with internal scroll so a long plan never
 * pushes the composer off-screen.
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown, Circle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTodos, type Todo } from "../chat/todos-store";

interface TodoPanelProps {
  sessionKey: string;
  composerFocused: boolean;
}

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
  const todos = useTodos(sessionKey);
  const [expanded, setExpanded] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  // A new write_todos call (todos ref changed) clears the X-dismissed state
  // and re-expands the panel — fresh agent activity always resurfaces. If
  // the composer is focused at that moment we keep it collapsed so a typing
  // user isn't interrupted; the header still shows the progress chip.
  useEffect(() => {
    setDismissed(false);
    setExpanded(!composerFocused);
    // Intentionally NOT watching composerFocused here — that's handled by
    // the second effect. We only want a write_todos to trigger this reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos]);

  // Composer focus → collapse so the typing area gets the height. Blur
  // alone does not auto-expand; we wait for the next write_todos.
  useEffect(() => {
    if (composerFocused) setExpanded(false);
  }, [composerFocused]);

  if (todos.length === 0 || dismissed) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const allDone = completed === todos.length;

  return (
    <div className="mx-2 mb-1 rounded-xl border border-foreground/10 bg-white/70 backdrop-blur-sm shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[13px] font-medium text-foreground/80">Plan</span>
        <span
          className={cn(
            "text-[12px]",
            allDone ? "text-emerald-600" : "text-foreground/45",
          )}
        >
          · {completed}/{todos.length} done
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
            onClick={() => setDismissed(true)}
            aria-label="Close plan"
            className="p-1 rounded-md text-foreground/50 hover:text-foreground/80 hover:bg-foreground/10 transition-colors"
          >
            <X size={14} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {expanded && (
        <ul className="max-h-[200px] overflow-y-auto px-3 pb-2 pt-0.5 space-y-1.5">
          {todos.map((todo, i) => (
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
