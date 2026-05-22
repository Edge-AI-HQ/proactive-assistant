import { fireEvent, render, screen } from "@testing-library/react";
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
