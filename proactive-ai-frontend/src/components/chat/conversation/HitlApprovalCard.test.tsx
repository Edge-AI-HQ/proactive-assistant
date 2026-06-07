import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { HitlApprovalCard, type HitlRequiresAction } from "@/components/chat/conversation/HitlApprovalCard";

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
