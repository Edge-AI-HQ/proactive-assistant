import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { HitlApprovalCard, type HitlRequiresAction } from "./HitlApprovalCard";

const action: HitlRequiresAction = {
  toolUseId: "iid-1",
  toolName: "GMAIL_SEND_DRAFT",
  argsPreview: "to: a@b.com",
  allowedDecisions: ["approve", "reject"],
};

describe("HitlApprovalCard", () => {
  test("approve fires onDecide('approve')", () => {
    const onDecide = vi.fn();
    render(<HitlApprovalCard action={action} onDecide={onDecide} />);
    fireEvent.click(screen.getByText("Approve"));
    expect(onDecide).toHaveBeenCalledWith("approve");
  });

  test("reject opens a reason box, then fires onDecide('reject', reason)", () => {
    const onDecide = vi.fn();
    render(<HitlApprovalCard action={action} onDecide={onDecide} />);
    // First Reject opens the reason panel (no decision yet).
    fireEvent.click(screen.getByText("Reject"));
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/tell the agent why/i), {
      target: { value: "not now" },
    });
    // The panel's Reject confirms.
    fireEvent.click(screen.getByText("Reject"));
    expect(onDecide).toHaveBeenCalledWith("reject", "not now");
  });

  test("disabled greys the buttons and blocks decisions", () => {
    const onDecide = vi.fn();
    render(<HitlApprovalCard action={action} disabled onDecide={onDecide} />);
    const approve = screen.getByText("Approve").closest("button");
    expect(approve?.disabled).toBe(true);
    fireEvent.click(screen.getByText("Approve"));
    expect(onDecide).not.toHaveBeenCalled();
  });

  test("readOnly shows a resolved note with no action buttons", () => {
    const onDecide = vi.fn();
    render(<HitlApprovalCard action={action} readOnly onDecide={onDecide} />);
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.queryByText("Reject")).toBeNull();
    expect(screen.getByText(/resolved earlier/i)).toBeTruthy();
  });

  test("preference_add renders friendly copy from structured args, not raw JSON", () => {
    render(
      <HitlApprovalCard
        action={{
          toolUseId: "iid-2",
          toolName: "preference_add",
          argsPreview:
            '{"statement":"Show me more A-share market news","scope":"topic","polarity":"positive"}',
          args: {
            statement: "Show me more A-share market news",
            scope: "topic",
            polarity: "positive",
          },
          allowedDecisions: ["approve", "reject"],
        }}
        onDecide={vi.fn()}
      />,
    );
    // Friendly title instead of the internal tool name.
    expect(screen.getByText("Save a preference")).toBeTruthy();
    // The user's own statement, shown plainly.
    expect(screen.getByText("Show me more A-share market news")).toBeTruthy();
    // Internal mechanics + raw JSON are hidden.
    expect(screen.queryByText("preference_add")).toBeNull();
    expect(screen.queryByText(/polarity/)).toBeNull();
  });

  test("composio multi-execute: a single call shows its humanized slug", () => {
    render(
      <HitlApprovalCard
        action={{
          toolUseId: "iid-3",
          toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
          argsPreview: '{"calls":[{"tool_slug":"GMAIL_SEND_DRAFT"}]}',
          args: { calls: [{ tool_slug: "GMAIL_SEND_DRAFT", arguments: {} }] },
          allowedDecisions: ["approve", "reject"],
        }}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("Gmail send draft")).toBeTruthy();
    expect(screen.queryByText(/tool_slug/)).toBeNull();
  });

  test("composio multi-execute: multiple calls summarize as a labelled list", () => {
    render(
      <HitlApprovalCard
        action={{
          toolUseId: "iid-4",
          toolName: "COMPOSIO_MULTI_EXECUTE_TOOL",
          args: {
            calls: [
              { tool_slug: "GMAIL_SEND_DRAFT", arguments: {} },
              { tool_slug: "SLACK_SEND_MESSAGE", arguments: {} },
            ],
          },
          allowedDecisions: ["approve", "reject"],
        }}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("Run 2 actions")).toBeTruthy();
    expect(screen.getByText(/Gmail send draft/)).toBeTruthy();
    expect(screen.getByText(/Slack send message/)).toBeTruthy();
  });

  test("respects allowedDecisions (approve-only hides Reject)", () => {
    render(
      <HitlApprovalCard
        action={{ ...action, allowedDecisions: ["approve"] }}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.queryByText("Reject")).toBeNull();
  });
});
