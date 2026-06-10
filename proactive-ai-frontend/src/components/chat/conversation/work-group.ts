/**
 * Pure segmentation of an assistant turn's parts into the work-group
 * rendering model (Claude.ai segment rule):
 *
 *   - `text` parts are the narrative spine — each is its own segment and
 *     closes the open work group.
 *   - `propose_action` / `notify_user` are user-facing cards — own segment,
 *     also close the group.
 *   - everything else (reasoning, tool calls, task delegations) flows into
 *     the current work group, rendered as one collapsible rail.
 *
 * Inside a group, tool parts carrying `parentTaskId` nest under their task's
 * card. Unknown parents (old data, HITL-resume streams that lost the mapping)
 * degrade to plain tool nodes — the flat pre-attribution rendering.
 *
 * Kept free of React so the grouping invariants are unit-testable.
 */

import type { ConversationContentPart } from "@/components/chat/conversation/tool-steps";

export type ToolCallPart = Extract<ConversationContentPart, { type: "tool-call" }>;

export type WorkGroupItem =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; part: ToolCallPart }
  | { kind: "task"; part: ToolCallPart; children: ToolCallPart[] };

export interface WorkGroupData {
  items: WorkGroupItem[];
  /** Async LLM title (backfilled onto the group's first tool part). */
  title?: string;
  /** Total tool calls in the group, nested ones included. */
  toolCount: number;
  hasError: boolean;
  /** Any direct tool / task in the group still awaiting its result. */
  hasRunning: boolean;
}

export type AssistantSegment =
  | { kind: "text"; key: string; text: string }
  | { kind: "special"; key: string; part: ToolCallPart }
  | { kind: "group"; key: string; group: WorkGroupData };

const SPECIAL_TOOLS = new Set(["propose_action", "notify_user"]);

/** Single source for a tool part's lifecycle state (rail nodes, cards and
 *  segmentation all derive from it). */
export function toolStatus(part: ToolCallPart): "running" | "ok" | "error" {
  if (part.isError) return "error";
  if (part.result) return part.result.ok ? "ok" : "error";
  const s = part.args["status"];
  if (s === "ok") return "ok";
  if (s === "error") return "error";
  return "running";
}

export function segmentAssistantParts(
  parts: ConversationContentPart[],
): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let group: WorkGroupData | null = null;
  // Index of the open group's FIRST part — its segment key. Keys must be
  // stable while a streaming group grows (a close-index key would change on
  // every appended part, remounting the component and dropping its state).
  let groupStart = -1;
  let taskByCallId = new Map<string, Extract<WorkGroupItem, { kind: "task" }>>();

  const closeGroup = () => {
    if (group && group.items.length > 0) {
      segments.push({ kind: "group", key: `group-${groupStart}`, group });
    }
    group = null;
    groupStart = -1;
    taskByCallId = new Map();
  };

  const openGroup = (index: number): WorkGroupData => {
    if (!group) {
      group = { items: [], toolCount: 0, hasError: false, hasRunning: false };
      groupStart = index;
    }
    return group;
  };

  parts.forEach((part, i) => {
    if (part.type === "text") {
      closeGroup();
      if (part.text) segments.push({ kind: "text", key: `text-${i}`, text: part.text });
      return;
    }
    if (part.type === "reasoning") {
      const g = openGroup(i);
      g.items.push({ kind: "reasoning", text: part.text });
      return;
    }
    // tool-call. A subagent's own propose_action / notify_user must NOT be
    // promoted to a top-level card — only the orchestrator speaks to the
    // user; nested ones stay plain tool nodes inside their task card.
    if (SPECIAL_TOOLS.has(part.toolName) && !part.parentTaskId) {
      closeGroup();
      segments.push({ kind: "special", key: `special-${part.toolCallId}`, part });
      return;
    }
    const g = openGroup(i);
    g.toolCount += 1;
    if (part.isError) g.hasError = true;
    if (toolStatus(part) === "running") g.hasRunning = true;
    if (!g.title && part.groupTitle) g.title = part.groupTitle;

    if (part.parentTaskId) {
      const owner = taskByCallId.get(part.parentTaskId);
      if (owner) {
        owner.children.push(part);
        return;
      }
      // Unknown parent → flat tool node (pre-attribution degradation).
    }
    if (part.toolName === "task") {
      const item: Extract<WorkGroupItem, { kind: "task" }> = {
        kind: "task",
        part,
        children: [],
      };
      taskByCallId.set(part.toolCallId, item);
      g.items.push(item);
      return;
    }
    g.items.push({ kind: "tool", part });
  });
  closeGroup();
  return segments;
}

/** Short human description of a task card, from the tool input. */
export function taskDescription(part: ToolCallPart): string {
  const input = part.args["input"];
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const desc = (input as { description?: unknown }).description;
    if (typeof desc === "string" && desc.trim()) return desc.trim();
  }
  // argsPreview (a JSON-ish preview string) is the degraded fallback when
  // the structured input was dropped (e.g. oversized args).
  const preview = part.args["argsPreview"];
  return typeof preview === "string" ? preview : "";
}
