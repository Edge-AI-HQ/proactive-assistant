// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { setTodos } from "@pin-ai/state";
import TodoPanel from "./TodoPanel";

function toggleButtons(label: RegExp) {
  return screen.getAllByRole("button", { name: label });
}

describe("TodoPanel", () => {
  test("clicking the title area toggles the plan", () => {
    const sessionKey = "todo-panel-title-toggle";
    setTodos(
      sessionKey,
      [
        { content: "Gather context", status: "completed" },
        { content: "Draft answer", status: "in_progress" },
      ],
      "turn-1",
    );

    render(<TodoPanel sessionKey={sessionKey} composerFocused={false} />);

    expect(screen.getByText("Gather context")).toBeTruthy();

    fireEvent.click(toggleButtons(/collapse plan|collapsePlan|收起计划/i)[0]);
    expect(screen.queryByText("Gather context")).toBeNull();

    fireEvent.click(toggleButtons(/expand plan|expandPlan|展开计划/i)[0]);
    expect(screen.getByText("Gather context")).toBeTruthy();
  });
});
