import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@capacitor/browser", () => ({
  Browser: { open: vi.fn() },
}));

vi.mock("@/components/ConnectChip", () => ({
  ConnectChip: ({ toolkit }: { toolkit: string }) => (
    <button type="button">Connect {toolkit}</button>
  ),
}));

import MarkdownContent from "./MarkdownContent";

describe("MarkdownContent connector chips", () => {
  test("replaces inline connect tags outside code blocks", () => {
    render(<MarkdownContent text="Please connect this. [connect:gmail]" />);

    expect(screen.getByRole("button", { name: "Connect gmail" })).toBeTruthy();
    expect(screen.queryByText("[connect:gmail]")).toBeNull();
  });

  test("keeps connect tags literal inside code blocks", () => {
    render(<MarkdownContent text={"```text\n[connect:gmail]\n```"} />);

    expect(screen.queryByRole("button", { name: "Connect gmail" })).toBeNull();
    expect(screen.getByText("[connect:gmail]")).toBeTruthy();
  });
});
