/**
 * Cross-platform helper for opening a Composio OAuth URL and resolving
 * once the user dismisses the auth surface.
 *
 * Web: popup window + closed-polling.
 * Native (Capacitor): in-app `@capacitor/browser` + browserFinished event.
 * `window.open` to external origins silently fails inside WKWebView, so
 * native MUST go through `@capacitor/browser`.
 *
 * Previously inlined in `components/DataConnections.tsx`. Pulled out so
 * the connector-guidance card / chat chip flow can reuse the exact same
 * popup behavior without copy-pasting (or worse, drifting from) the
 * settings page logic.
 */
import { Browser } from "@capacitor/browser";

import { isNative } from "./platform";

/** Resolves when the popup window is closed (+ 3s grace for OAuth callback). */
function windowClosed(win: Window | null): Promise<void> {
  return new Promise((resolve) => {
    if (!win) return;
    const poll = setInterval(() => {
      if (win.closed) {
        clearInterval(poll);
        setTimeout(resolve, 3000);
      }
    }, 1000);
  });
}

export async function openOAuthAndAwaitClose(url: string): Promise<void> {
  if (isNative) {
    const closedPromise = new Promise<void>((resolve) => {
      void Browser.addListener("browserFinished", () => {
        void Browser.removeAllListeners();
        setTimeout(resolve, 3000);
      });
    });
    await Browser.open({ url, presentationStyle: "popover" });
    return closedPromise;
  }
  const win = window.open(url, "_blank");
  return windowClosed(win);
}
