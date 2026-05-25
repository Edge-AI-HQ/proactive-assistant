import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { EditableUserMessageComposer } from "./EditableUserMessageComposer";

describe("EditableUserMessageComposer", () => {
  test("keeps the inline edit textarea editable and sends the latest draft", () => {
    const onDraftChange = vi.fn();
    const onCancel = vi.fn();
    const onSend = vi.fn();

    render(
      <EditableUserMessageComposer
        initialText="What should I focus on today?"
        onDraftChange={onDraftChange}
        onCancel={onCancel}
        onSend={onSend}
      />,
    );

    const editor = screen.getByRole("textbox");
    expect((editor as HTMLTextAreaElement).value).toBe(
      "What should I focus on today?",
    );

    fireEvent.change(editor, { target: { value: "Review the PIN AI branch" } });

    expect((editor as HTMLTextAreaElement).value).toBe(
      "Review the PIN AI branch",
    );
    expect(onDraftChange).toHaveBeenLastCalledWith("Review the PIN AI branch");

    fireEvent.click(screen.getByRole("button", { name: "Save & Send" }));

    expect(onSend).toHaveBeenCalledWith("Review the PIN AI branch");
  });

  test("focuses the textarea when the user clicks the edit bubble", () => {
    render(
      <EditableUserMessageComposer
        initialText="What should I focus on today?"
        onDraftChange={vi.fn()}
        onCancel={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    const editor = screen.getByRole("textbox");
    fireEvent.blur(editor);

    fireEvent.mouseDown(screen.getByTestId("user-edit-composer"));

    expect(document.activeElement).toBe(editor);
    expect((editor as HTMLTextAreaElement).selectionStart).toBe(
      "What should I focus on today?".length,
    );
  });
});

describe("MainChatView reasoning rendering", () => {
  test("does not parse inline thinking tags as displayable reasoning", () => {
    const sourcePath = resolve(
      process.cwd(),
      "src/components/main-chat/MainChatView.tsx",
    );
    const source = readFileSync(sourcePath, "utf8");

    expect(source).not.toContain("parseThinkingFromText");
    expect(source).not.toContain("<thinking>");
    expect(source).not.toContain("<think>");
  });
});
