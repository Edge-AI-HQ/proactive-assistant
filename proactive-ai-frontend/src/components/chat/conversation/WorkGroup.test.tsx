import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import WorkGroup from "@/components/chat/conversation/WorkGroup";
import TaskCard from "@/components/chat/conversation/TaskCard";
import type {
  ToolCallPart,
  WorkGroupData,
  WorkGroupItem,
} from "@/components/chat/conversation/work-group";

function tool(
  id: string,
  name: string,
  status: "running" | "ok" | "error" = "ok",
  extra: Partial<ToolCallPart> = {},
): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: name,
    args: { status },
    argsText: "{}",
    ...(status !== "running"
      ? { result: { ok: status === "ok" }, ...(status === "error" ? { isError: true } : {}) }
      : {}),
    ...extra,
  } as ToolCallPart;
}

function groupOf(items: WorkGroupItem[], extra: Partial<WorkGroupData> = {}): WorkGroupData {
  return {
    items,
    toolCount: items.filter((i) => i.kind !== "reasoning").length,
    hasError: false,
    hasRunning: false,
    ...extra,
  };
}

describe("WorkGroup", () => {
  test("streaming group shows the live status line and an open rail", () => {
    const group = groupOf(
      [
        { kind: "reasoning", text: "planning the work" },
        { kind: "tool", part: tool("c1", "tavily_search", "running") },
      ],
      { hasRunning: true },
    );

    render(<WorkGroup group={group} streaming />);

    // The running tool's verb appears twice: header status line + open rail.
    expect(screen.getAllByText("Searched web")).toHaveLength(2);
    // Rail is open: the streaming thinking tail is visible.
    expect(screen.getByText(/planning the work/)).toBeTruthy();
  });

  test("settled group collapses to LLM title, expands on tap", () => {
    const group = groupOf(
      [
        { kind: "tool", part: tool("c1", "tavily_search", "ok", { groupTitle: "调研了定价" }) },
        { kind: "tool", part: tool("c2", "world_search") },
      ],
      { title: "调研了定价" },
    );

    render(<WorkGroup group={group} streaming={false} />);

    expect(screen.getByText("调研了定价")).toBeTruthy();
    // Collapsed: node rows hidden.
    expect(screen.queryByText("Searched web")).toBeNull();
    fireEvent.click(screen.getByText("调研了定价"));
    expect(screen.getByText("Searched web")).toBeTruthy();
  });

  test("settled group without a title falls back to the tool count", () => {
    const group = groupOf([
      { kind: "tool", part: tool("c1", "memory_search") },
      { kind: "tool", part: tool("c2", "memory_get") },
    ]);

    render(<WorkGroup group={group} streaming={false} />);

    expect(screen.getByText("Used 2 tools")).toBeTruthy();
  });

  test("reasoning-only group settles as 'Thought' with no step badge", () => {
    // Every plain extended-thinking reply forms a tool-less group — it must
    // not read "Used 0 tools · 0 steps".
    const group = groupOf([{ kind: "reasoning", text: "pondering the question" }]);

    render(<WorkGroup group={group} streaming={false} />);

    expect(screen.getByText("Thought")).toBeTruthy();
    expect(screen.queryByText(/0 steps/)).toBeNull();
    expect(screen.queryByText(/0 tools/)).toBeNull();
  });

  test("fallback label counts top-level nodes, not nested subagent calls", () => {
    // 2 tasks that internally made 200 calls must NOT fall back to
    // "Used 202 tools" — that's the wall of noise this component kills.
    const nested = Array.from({ length: 100 }, (_, i) =>
      tool(`n${i}`, "tavily_search", "ok", { parentTaskId: "t1" }),
    );
    const group = groupOf(
      [
        { kind: "task", part: tool("t1", "task"), children: nested },
        { kind: "task", part: tool("t2", "task"), children: [] },
      ],
      { toolCount: 102 },
    );

    render(<WorkGroup group={group} streaming={false} />);

    expect(screen.getByText("Ran 2 subtasks")).toBeTruthy();
    expect(screen.getByText("2 steps")).toBeTruthy();
  });

  test("multiple running subtasks aggregate in the status line", () => {
    const group = groupOf(
      [
        {
          kind: "task",
          part: tool("t1", "task", "running"),
          children: [],
        },
        {
          kind: "task",
          part: tool("t2", "task", "running"),
          children: [],
        },
      ],
      { hasRunning: true },
    );

    render(<WorkGroup group={group} streaming />);

    expect(screen.getByText("2 subtasks running")).toBeTruthy();
  });
});

describe("TaskCard", () => {
  const taskItem = (children: ToolCallPart[], status: "running" | "ok" = "ok") =>
    ({
      kind: "task" as const,
      part: tool("t1", "task", status, {
        args: {
          status,
          input: { description: "Research pricing models" },
          meta: "Final subagent answer",
        },
      } as Partial<ToolCallPart>),
      children,
    });

  test("collapsed row shows description and tool counter", () => {
    render(
      <TaskCard
        item={taskItem([tool("n1", "tavily_search"), tool("n2", "browser_tool")])}
      />,
    );

    expect(screen.getByText("Research pricing models")).toBeTruthy();
    expect(screen.getByText(/Done · 2 tools/)).toBeTruthy();
  });

  test("running card surfaces the current child action", () => {
    render(
      <TaskCard
        item={taskItem([tool("n1", "browser_tool", "running")], "running")}
      />,
    );

    expect(screen.getByText(/1 tool · Browsed/)).toBeTruthy();
  });

  test("expanding reveals the nested rail and the subagent answer", () => {
    render(
      <TaskCard item={taskItem([tool("n1", "tavily_search")])} />,
    );

    fireEvent.click(screen.getByText("Research pricing models"));
    expect(screen.getByText("Searched web")).toBeTruthy();
    expect(screen.getByText("Final subagent answer")).toBeTruthy();
  });

  test("windows long child lists behind Show more", () => {
    const children = Array.from({ length: 45 }, (_, i) => tool(`n${i}`, "tavily_search"));
    render(<TaskCard item={taskItem(children)} />);

    fireEvent.click(screen.getByText("Research pricing models"));
    expect(screen.getAllByText("Searched web")).toHaveLength(30);
    fireEvent.click(screen.getByText(/Show more/));
    expect(screen.getAllByText("Searched web")).toHaveLength(45);
  });
});
