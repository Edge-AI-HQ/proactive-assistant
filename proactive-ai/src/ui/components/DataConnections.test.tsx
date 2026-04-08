import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import DataConnections from "./DataConnections";
import type { ComposioState } from "@/hooks/use-composio";

function createComposioState(overrides: Partial<ComposioState> = {}): ComposioState {
  return {
    keyStatus: { configured: true },
    connections: [],
    statusLoading: false,
    loadingConns: false,
    loadStatus: vi.fn(async () => {}),
    loadConnections: vi.fn(async () => {}),
    saveApiKey: vi.fn(async () => ({ ok: true })),
    connectToolkit: vi.fn(async () => ({ ok: true, redirectUrl: "https://example.com/oauth" })),
    waitForToolkit: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("DataConnections", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("restores the connect button after the OAuth window closes without completing auth", async () => {
    let popupClosed = false;
    vi.spyOn(window, "open").mockImplementation(() => {
      const popup = {
        get closed() {
          return popupClosed;
        },
      } as Window;

      setTimeout(() => {
        popupClosed = true;
      }, 300);

      return popup;
    });

    const composio = createComposioState({
      waitForToolkit: vi.fn(() => new Promise<void>(() => {})),
    });

    await act(async () => {
      root.render(<DataConnections composio={composio} />);
    });

    const categoryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Email & Calendar"),
    );
    expect(categoryButton).toBeTruthy();

    await act(async () => {
      categoryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Connect",
    ) as HTMLButtonElement | undefined;
    expect(connectButton).toBeTruthy();

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("OAuth window opened");

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    const restoredButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Connect",
    ) as HTMLButtonElement | undefined;

    expect(restoredButton).toBeTruthy();
    expect(restoredButton?.disabled).toBe(false);
  });
});
