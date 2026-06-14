/**
 * One delegated subagent (`task` tool call) as a rail node.
 *
 * Collapsed (always the default): one row — Bot icon, the task description,
 * live tool counter and the current action while running, ✓/✗ when done.
 * Expanded: the subagent's own tool calls as a nested mini-rail (inline,
 * max-height + inner scroll — no bottom sheet on mobile) plus its final
 * answer once available. Children beyond a window mount on "Show more" so a
 * 200-call research subagent doesn't flood the DOM.
 */
import { useState } from "react";
import { Bot, Check, ChevronDown, Loader2, AlertCircle } from "lucide-react";
import { cn } from "../../lib/utils";
import MarkdownContent from "./MarkdownContent";
import { ToolNodeRow } from "./WorkGroupNodes";
import { resolveToolPresentation } from "./tool-presentation";
import {
  taskDescription,
  toolStatus,
  type ToolCallPart,
  type WorkGroupItem,
} from "@pin-ai/core";
import { Text } from "../../primitives/Text";

const CHILDREN_WINDOW = 30;

type TaskItem = Extract<WorkGroupItem, { kind: "task" }>;

/** The verb of the subagent's most recent still-running call — the "current
 *  action" line that makes a busy card feel alive. */
function currentAction(children: ToolCallPart[]): string | null {
  for (let i = children.length - 1; i >= 0; i--) {
    if (toolStatus(children[i]) === "running") {
      return resolveToolPresentation(children[i].toolName).verb;
    }
  }
  return null;
}

export default function TaskCard({ item }: { item: TaskItem }) {
  const [expanded, setExpanded] = useState(false);
  const [childLimit, setChildLimit] = useState(CHILDREN_WINDOW);
  const status = toolStatus(item.part);
  const running = status === "running";
  const description = taskDescription(item.part) || "Subtask";
  const action = running ? currentAction(item.children) : null;
  const resultMeta = item.part.args["meta"];
  const visibleChildren = expanded ? item.children.slice(0, childLimit) : [];

  return (
    <div className="rounded-xl border border-foreground/[0.08] bg-white/55 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left hover:bg-foreground/[0.03]"
      >
        <span className="relative shrink-0 w-[26px] h-[26px] rounded-[7px] border border-foreground/10 bg-white/90 flex items-center justify-center">
          <Bot size={13} strokeWidth={1.8} className="text-foreground/75" />
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 w-[11px] h-[11px] rounded-full border-[1.5px] border-white flex items-center justify-center",
              status === "ok"
                ? "bg-emerald-500"
                : status === "error"
                  ? "bg-red-500"
                  : "bg-white/95",
            )}
          >
            {status === "ok" ? (
              <Check size={7} strokeWidth={4} className="text-white" />
            ) : status === "error" ? (
              <AlertCircle size={7} strokeWidth={3} className="text-white" />
            ) : (
              <Loader2
                size={7}
                strokeWidth={3}
                className="animate-spin text-[hsl(304_75%_50%)]"
              />
            )}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <Text variant="bodySm" weight="medium" className="block truncate text-foreground/85 leading-tight">
            {description}
          </Text>
          <Text variant="caption" className="block truncate text-foreground/45 leading-tight">
            {(() => {
              const n = item.children.length;
              const tools = `${n} tool${n === 1 ? "" : "s"}`;
              return running
                ? `${tools}${action ? ` · ${action}` : ""}`
                : `Done · ${tools}`;
            })()}
          </Text>
        </span>
        <ChevronDown
          size={13}
          strokeWidth={1.6}
          className={cn(
            "shrink-0 text-foreground/35 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-foreground/[0.06] px-2.5 pb-2.5 pt-1.5">
          <div className="max-h-[280px] overflow-y-auto space-y-1">
            {visibleChildren.map((child) => (
              <ToolNodeRow key={child.toolCallId} part={child} compact />
            ))}
            {item.children.length > childLimit && (
              <button
                type="button"
                onClick={() => setChildLimit((n) => n + CHILDREN_WINDOW)}
                className="w-full py-1 text-caption text-foreground/50 hover:text-foreground/75"
              >
                Show more ({item.children.length - childLimit})
              </button>
            )}
            {item.children.length === 0 && (
              <Text variant="caption" className="block py-1 text-foreground/40">No tool activity yet.</Text>
            )}
          </div>
          {typeof resultMeta === "string" && resultMeta && !running && (
            <div className="mt-2 rounded-lg bg-foreground/[0.03] px-2.5 py-2 text-label">
              <MarkdownContent text={resultMeta} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
