import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import BrowserView from "./BrowserView";

function renderBrowserView(overrides: Partial<Parameters<typeof BrowserView>[0]> = {}) {
  const props: Parameters<typeof BrowserView>[0] = {
    liveViewUrl: "https://live.example.test",
    sessionId: "session-1",
    controlMode: "ai",
    takeoverReason: null,
    sheetStage: "medium",
    isNative: true,
    viewport: { width: 1280, height: 800 },
    onUserInputText: vi.fn(async () => undefined),
    onUserInputKey: vi.fn(async () => undefined),
    onUserInputClick: vi.fn(async () => undefined),
    onUserInputScroll: vi.fn(async () => undefined),
    onControlChange: vi.fn(),
    onCycleStage: vi.fn(),
    onRequestClose: vi.fn(),
    onChromePointerDown: vi.fn(),
    ...overrides,
  };
  render(<BrowserView {...props} />);
  return props;
}

describe("BrowserView", () => {
  test("Take over button switches control to user", () => {
    const props = renderBrowserView();
    fireEvent.click(screen.getByRole("button", { name: /take over/i }));
    expect(props.onControlChange).toHaveBeenCalledWith("user");
  });

  test("Keyboard button is rendered in native mode", () => {
    renderBrowserView();
    expect(screen.getByTitle("Type")).toBeTruthy();
  });
});
