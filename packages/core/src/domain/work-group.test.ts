import { describe, expect, it } from "vitest";
import {
  segmentAssistantParts,
  taskDescription,
  type ToolCallPart,
} from "./work-group";
import type { ConversationContentPart } from "../machines/tool-steps";

function tool(
  id: string,
  name: string,
  extra: Partial<ToolCallPart> = {},
  status = "ok",
): ConversationContentPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: name,
    args: { status },
    argsText: "{}",
    ...(status !== "running" ? { result: { ok: status === "ok" } } : {}),
    ...extra,
  };
}

describe("segmentAssistantParts", () => {
  it("text splits work groups; reasoning+tools merge into one rail", () => {
    const segments = segmentAssistantParts([
      { type: "reasoning", text: "plan" },
      tool("c1", "tavily_search"),
      tool("c2", "world_search"),
      { type: "text", text: "progress" },
      tool("c3", "memory_search"),
      { type: "text", text: "final" },
    ]);

    expect(segments.map((s) => s.kind)).toEqual([
      "group",
      "text",
      "group",
      "text",
    ]);
    const first = segments[0];
    if (first.kind !== "group") throw new Error("expected group");
    expect(first.group.items.map((i) => i.kind)).toEqual([
      "reasoning",
      "tool",
      "tool",
    ]);
    expect(first.group.toolCount).toBe(2);
  });

  it("nests attributed tools under their task card", () => {
    const segments = segmentAssistantParts([
      tool("task-1", "task", {
        args: { status: "running", input: { description: "research pricing" } },
      } as Partial<ToolCallPart>),
      tool("n1", "tavily_search", { parentTaskId: "task-1" }),
      tool("n2", "browser_tool", { parentTaskId: "task-1" }),
      tool("m1", "memory_search"),
    ]);

    const [seg] = segments;
    if (seg.kind !== "group") throw new Error("expected group");
    const [taskItem, plainItem] = seg.group.items;
    if (taskItem.kind !== "task") throw new Error("expected task item");
    expect(taskItem.children.map((c) => c.toolCallId)).toEqual(["n1", "n2"]);
    expect(plainItem.kind).toBe("tool");
    expect(seg.group.toolCount).toBe(4);
  });

  it("unknown parentTaskId degrades to a flat tool node", () => {
    const segments = segmentAssistantParts([
      tool("n1", "tavily_search", { parentTaskId: "missing-task" }),
    ]);

    const [seg] = segments;
    if (seg.kind !== "group") throw new Error("expected group");
    expect(seg.group.items).toEqual([
      expect.objectContaining({ kind: "tool" }),
    ]);
  });

  it("special tools (propose_action / notify_user) break out of the group", () => {
    const segments = segmentAssistantParts([
      tool("c1", "memory_search"),
      tool("p1", "propose_action"),
      tool("n1", "notify_user"),
    ]);

    expect(segments.map((s) => s.kind)).toEqual(["group", "special", "special"]);
  });

  it("group title comes from the first titled tool part", () => {
    const segments = segmentAssistantParts([
      tool("c1", "tavily_search", { groupTitle: "调研了定价" }),
      tool("c2", "world_search"),
    ]);

    const [seg] = segments;
    if (seg.kind !== "group") throw new Error("expected group");
    expect(seg.group.title).toBe("调研了定价");
  });

  it("tracks running and error flags", () => {
    const segments = segmentAssistantParts([
      tool("c1", "tavily_search", { isError: true }, "error"),
      tool("c2", "browser_tool", {}, "running"),
    ]);

    const [seg] = segments;
    if (seg.kind !== "group") throw new Error("expected group");
    expect(seg.group.hasError).toBe(true);
    expect(seg.group.hasRunning).toBe(true);
  });

  it("empty text parts do not create segments", () => {
    const segments = segmentAssistantParts([
      { type: "text", text: "" },
      tool("c1", "memory_search"),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(["group"]);
  });

  it("a streaming group's key stays stable as parts append", () => {
    // React remounts (and drops expand/animation state) when a key changes —
    // a streaming group grows every frame, so its key must come from its
    // FIRST part, not from where it currently ends.
    const base: ConversationContentPart[] = [
      { type: "text", text: "intro" },
      { type: "reasoning", text: "plan" },
      tool("c1", "tavily_search", {}, "running"),
    ];
    const keyOf = (parts: ConversationContentPart[]) => {
      const seg = segmentAssistantParts(parts).at(-1);
      if (seg?.kind !== "group") throw new Error("expected trailing group");
      return seg.key;
    };

    const before = keyOf(base);
    const after = keyOf([...base, tool("c2", "world_search", {}, "running")]);
    expect(after).toBe(before);
  });

  it("a subagent's nested special tools stay inside the task card", () => {
    const segments = segmentAssistantParts([
      tool("task-1", "task", {}, "running"),
      tool("p1", "propose_action", { parentTaskId: "task-1" }),
    ]);

    expect(segments.map((s) => s.kind)).toEqual(["group"]);
    const [seg] = segments;
    if (seg.kind !== "group") throw new Error("expected group");
    const [taskItem] = seg.group.items;
    if (taskItem.kind !== "task") throw new Error("expected task item");
    expect(taskItem.children.map((c) => c.toolName)).toEqual(["propose_action"]);
  });
});

describe("taskDescription", () => {
  it("prefers the structured input description", () => {
    const part = tool("task-1", "task", {
      args: {
        status: "ok",
        input: { description: "research pricing models" },
        argsPreview: '{"description": "research pricing models"}',
      },
    } as Partial<ToolCallPart>) as ToolCallPart;
    expect(taskDescription(part)).toBe("research pricing models");
  });

  it("falls back to argsPreview", () => {
    const part = tool("task-1", "task", {
      args: { status: "ok", argsPreview: "preview text" },
    } as Partial<ToolCallPart>) as ToolCallPart;
    expect(taskDescription(part)).toBe("preview text");
  });
});
