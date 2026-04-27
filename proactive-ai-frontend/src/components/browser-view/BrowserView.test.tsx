import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import BrowserView from "./BrowserView";

function renderBrowserView(overrides: Partial<Parameters<typeof BrowserView>[0]> = {}) {
  const props: Parameters<typeof BrowserView>[0] = {
    liveViewUrl: "https://live.example.test",
    sessionId: "session-1",
    currentUrl: "https://example.test/page",
    controlMode: "ai",
    takeoverReason: null,
    sheetStage: "medium",
    isNative: true,
    viewport: { width: 390, height: 844 },
    onControlChange: vi.fn(),
    onUserInputText: vi.fn(async () => undefined),
    onUserInputKey: vi.fn(async () => undefined),
    onUserInputClick: vi.fn(async () => undefined),
    onUserInputScroll: vi.fn(async () => undefined),
    onUserNavigate: vi.fn(async () => undefined),
    onUserBack: vi.fn(async () => undefined),
    onUserForward: vi.fn(async () => undefined),
    onUserPageReload: vi.fn(async () => undefined),
    onCycleStage: vi.fn(),
    onRequestClose: vi.fn(),
    onReload: vi.fn(),
    onChromePointerDown: vi.fn(),
    ...overrides,
  };
  render(<BrowserView {...props} />);
  return props;
}

describe("BrowserView takeover", () => {
  test("allows native users to take over the browser", () => {
    const props = renderBrowserView({ isNative: true });

    fireEvent.click(screen.getByRole("button", { name: /take over/i }));

    expect(props.onControlChange).toHaveBeenCalledWith("user");
  });

  test("sends mobile text and key input while user controls the browser", async () => {
    const props = renderBrowserView({ controlMode: "user", isNative: true });

    fireEvent.change(screen.getByPlaceholderText("Type into browser"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(props.onUserInputText).toHaveBeenCalledWith("123456");
    });

    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => {
      expect(props.onUserInputKey).toHaveBeenCalledWith("Enter");
    });
  });
});
