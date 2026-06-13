/**
 * One work group — the contiguous reasoning/tool/task run between two text
 * segments of an assistant turn — rendered as a collapsible vertical rail
 * (Claude.ai's research-segment block is the reference).
 *
 * Lifecycle mirrors the stream:
 *   streaming → the group is open: rail grows node by node, the header is a
 *               deterministic status line (current action) with a spinner.
 *   settled   → text arrived after it (or the turn ended): the group
 *               auto-collapses to one header row — the async LLM title once
 *               it lands (cross-fade), else "Used N tools" — with ✓ / error
 *               state. Tap to re-open the rail.
 *
 * Text rendering never waits on any of this: the parent renders text
 * segments independently; collapse is a 250ms height transition.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import TaskCard from "./TaskCard";
import { ThinkingNode, ToolNodeRow } from "./WorkGroupNodes";
import { resolveToolPresentation } from "./tool-presentation";
import {
  taskDescription,
  toolStatus,
  type WorkGroupData,
} from "@pin-ai/core";

const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

/** Deterministic status line while the group is open: the most recent
 *  still-running node's human description. */
function currentActivity(group: WorkGroupData): string {
  const runningTasks = group.items.filter(
    (i) => i.kind === "task" && toolStatus(i.part) === "running",
  );
  if (runningTasks.length > 1) return `${runningTasks.length} subtasks running`;
  for (let i = group.items.length - 1; i >= 0; i--) {
    const item = group.items[i];
    if (item.kind === "task" && toolStatus(item.part) === "running") {
      return taskDescription(item.part) || "Running subtask";
    }
    if (item.kind === "tool" && toolStatus(item.part) === "running") {
      return resolveToolPresentation(item.part.toolName).verb;
    }
  }
  return "Working…";
}

export default function WorkGroup({
  group,
  streaming,
}: {
  group: WorkGroupData;
  /** True while this group is the turn's live tail (no text after it yet). */
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(streaming);

  // The group settles exactly once (text arrived / turn ended) — collapse
  // then. Later manual expansion is the user's and we don't fight it.
  useEffect(() => {
    if (!streaming) setExpanded(false);
  }, [streaming]);

  // Deterministic fallback when no LLM title landed. Counts TOP-LEVEL rail
  // nodes, not nested subagent calls — "Used 206 tools" is exactly the wall
  // of noise this component exists to kill. A reasoning-only group (every
  // plain thinking reply) is just "Thought".
  const taskCount = group.items.filter((i) => i.kind === "task").length;
  const stepCount = group.items.filter((i) => i.kind !== "reasoning").length;
  const fallbackLabel =
    taskCount > 0
      ? `Ran ${taskCount} subtask${taskCount === 1 ? "" : "s"}`
      : stepCount > 0
        ? `Used ${stepCount} tool${stepCount === 1 ? "" : "s"}`
        : "Thought";
  const headerLabel = streaming
    ? currentActivity(group)
    : (group.title ?? fallbackLabel);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.25, ease: EASE }}
      className="mb-3 overflow-hidden rounded-2xl border border-foreground/10 bg-white/40"
      style={{
        backdropFilter: "blur(20px) saturate(1.3)",
        WebkitBackdropFilter: "blur(20px) saturate(1.3)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3.5 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        {streaming ? (
          <Loader2 size={11} strokeWidth={2.2} className="shrink-0 animate-spin text-foreground/45" />
        ) : group.hasError ? (
          <AlertCircle size={11} strokeWidth={2.5} className="shrink-0 text-red-500" />
        ) : (
          <Check size={11} strokeWidth={2.5} className="shrink-0 text-foreground/45" />
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={headerLabel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={cn(
              "min-w-0 flex-1 truncate text-[12px] text-foreground/60",
              streaming ? "font-normal" : "font-medium",
            )}
          >
            {headerLabel}
          </motion.span>
        </AnimatePresence>
        {!streaming && stepCount > 0 && (
          <span className="shrink-0 text-[10.5px] uppercase tracking-[0.12em] text-foreground/35">
            {stepCount} steps
          </span>
        )}
        <ChevronDown
          size={13}
          strokeWidth={1.6}
          className={cn(
            "shrink-0 text-foreground/35 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="ml-[18px] border-l border-foreground/[0.08] pl-3 pr-3 pb-2.5 pt-0.5 space-y-1">
              {group.items.map((item, i) => {
                const isLiveTail = streaming && i === group.items.length - 1;
                if (item.kind === "reasoning") {
                  return (
                    <ThinkingNode
                      key={`r-${i}`}
                      text={item.text}
                      streaming={isLiveTail}
                    />
                  );
                }
                if (item.kind === "task") {
                  return (
                    <motion.div
                      key={item.part.toolCallId}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.25,
                        delay: Math.min(i, 10) * 0.06,
                        ease: EASE,
                      }}
                    >
                      <TaskCard item={item} />
                    </motion.div>
                  );
                }
                return (
                  <motion.div
                    key={item.part.toolCallId}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.25,
                      delay: Math.min(i, 10) * 0.06,
                      ease: EASE,
                    }}
                  >
                    <ToolNodeRow part={item.part} />
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
