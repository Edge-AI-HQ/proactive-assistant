import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import BrowserView from "./BrowserView";

function renderBrowserView(overrides: Partial<Parameters<typeof BrowserView>[0]> = {}) {
  const props: Parameters<typeof BrowserView>[0] = {
    liveViewUrl: "https://live.example.test",
    sessionId: "session-1",
    controlMode: "ai",
    viewport: { width: 390, height: 844 },
    onControlChange: vi.fn(),
    onUserInputTap: vi.fn(async () => false),
    onUserInputText: vi.fn(async () => undefined),
    onUserInputKey: vi.fn(async () => undefined),
    onUserInputScroll: vi.fn(async () => undefined),
    currentUrl: "https://example.test/page",
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onNavigate: vi.fn(),
    onCollapse: vi.fn(),
    onRequestClose: vi.fn(),
    ...overrides,
  };
  render(<BrowserView {...props} />);
  return props;
}

// Gesture-overlay behaviour (tap → onUserInputTap, swipe → onUserInputScroll)
// depends on real layout (getBoundingClientRect) which jsdom doesn't provide,
// so it's covered by on-device verification, not here. These cover the
// control-model wiring that IS deterministic in jsdom.
describe("BrowserView", () => {
  test("Take over button switches control to user (explicit takeover)", () => {
    const props = renderBrowserView();
    fireEvent.click(screen.getByRole("button", { name: /take over/i }));
    expect(props.onControlChange).toHaveBeenCalledWith("user");
  });

  test("AI mode shows a capture layer that takes control on tap (implicit)", () => {
    const props = renderBrowserView();
    fireEvent.click(
      screen.getByRole("button", { name: /take control of the browser/i }),
    );
    expect(props.onControlChange).toHaveBeenCalledWith("user");
  });

  test("user mode shows Return to AI (no capture layer)", () => {
    const props = renderBrowserView({ controlMode: "user" });
    expect(screen.queryByRole("button", { name: /take control of the browser/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /return to ai/i }));
    expect(props.onControlChange).toHaveBeenCalledWith("ai");
  });

  test("no always-on keyboard button (Type appears only after focusing a field)", () => {
    renderBrowserView({ controlMode: "user" });
    expect(screen.queryByText("Type")).toBeNull();
  });
});
