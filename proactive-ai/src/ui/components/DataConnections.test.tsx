import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import DataConnections from "./DataConnections";
import type { ComposioState } from "@/hooks/use-composio";

function createComposioState(
  overrides: Partial<ComposioState> = {},
): ComposioState {
  return {
    keyStatus: { configured: true },
    connections: [],
    statusLoading: false,
    loadingConns: false,
    loadStatus: vi.fn(async () => {}),
    loadConnections: vi.fn(async () => []),
    saveApiKey: vi.fn(async () => ({ ok: true })),
    connectToolkit: vi.fn(async () => ({
      ok: true,
      redirectUrl: "https://example.com/oauth",
    })),
    disconnectAccount: vi.fn(async () => ({ ok: true })),
    waitForToolkit: vi.fn(async () => ({ connected: false })),
    cancelWait: vi.fn(),
    isToolkitConnected: vi.fn(() => false),
    ...overrides,
  };
}

describe("DataConnections", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows loading while waiting for OAuth, then restores button on failure", async () => {
    let resolveWait!: (value: { connected: boolean }) => void;
    const waitPromise = new Promise<{ connected: boolean }>((r) => {
      resolveWait = r;
    });

    vi.spyOn(window, "open").mockImplementation(() => null);

    const composio = createComposioState({
      waitForToolkit: vi.fn(() => waitPromise),
    });

    await act(async () => {
      root.render(<DataConnections composio={composio} />);
    });

    // Expand category
    const categoryButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Work"));
    await act(async () => {
      categoryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Click Connect
    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Connect",
    ) as HTMLButtonElement | undefined;
    expect(connectButton).toBeTruthy();

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Should show waiting message
    expect(container.textContent).toContain("Authorize in your browser");

    // Simulate backend returning not connected
    await act(async () => {
      resolveWait({ connected: false });
    });

    // Button should be restored
    const restoredButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Connect") as
      | HTMLButtonElement
      | undefined;
    expect(restoredButton).toBeTruthy();
    expect(restoredButton?.disabled).toBe(false);

    // Should show error
    expect(container.textContent).toContain("Connection not confirmed");
  });
});
