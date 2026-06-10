import { afterEach, describe, expect, test, vi } from "vitest";

import {
  PopupBlockedError,
  closeOAuthSurface,
  openOAuthAndAwaitClose,
} from "./oauth-popup";

// `isNative` is read at module init; for web-path tests it's false in
// the vitest jsdom env, which is what we want.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openOAuthAndAwaitClose (web)", () => {
  test("throws PopupBlockedError when window.open returns null", async () => {
    // Browsers return null from window.open when a popup is blocked
    // (Safari iOS default, Chrome strict mode, embedded WebViews,
    // user-installed popup blockers). The previous implementation
    // returned a Promise that never resolved — callers' "Connecting…"
    // spinners hung forever with no way to recover.
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    await expect(
      openOAuthAndAwaitClose("https://example.com/oauth"),
    ).rejects.toBeInstanceOf(PopupBlockedError);
    expect(openSpy).toHaveBeenCalledWith("https://example.com/oauth", "_blank");
  });

  test("resolves once the popup is closed", async () => {
    vi.useFakeTimers();
    try {
      const fakeWin = { closed: false } as Window;
      vi.spyOn(window, "open").mockReturnValue(fakeWin);

      const pending = openOAuthAndAwaitClose("https://example.com/oauth");
      // Polling cadence is 1s; mark closed and advance through poll +
      // the 3s OAuth-callback grace period.
      (fakeWin as { closed: boolean }).closed = true;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(3000);

      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("closeOAuthSurface (web)", () => {
  test("closes the popup opened by openOAuthAndAwaitClose", async () => {
    // After the backend confirms ACTIVE, the caller closes the surface
    // itself — Composio's hosted success page has no app deep-link to
    // dismiss it. On web that means closing the popup window we opened.
    const close = vi.fn();
    const fakeWin = { closed: false, close } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(fakeWin);

    // Open (don't await — the close-promise only settles on dismiss).
    void openOAuthAndAwaitClose("https://example.com/oauth");
    await closeOAuthSurface();

    expect(close).toHaveBeenCalledTimes(1);
  });

  test("is a no-op when no popup is open", async () => {
    await expect(closeOAuthSurface()).resolves.toBeUndefined();
  });
});
