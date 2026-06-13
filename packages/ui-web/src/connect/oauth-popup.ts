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

import { isNative } from "../auth/platform";

/**
 * Thrown when `window.open` returns null on the web path — Safari, mobile
 * Chrome strict mode, embedded WebViews, or a user-installed popup blocker
 * will all surface this. Callers catch it to clear their "connecting"
 * spinner instead of hanging on a Promise that will never settle.
 */
export class PopupBlockedError extends Error {
  constructor(message = "Popup was blocked by the browser") {
    super(message);
    this.name = "PopupBlockedError";
  }
}

/** Resolves when the popup window is closed (+ 3s grace for OAuth callback). */
function windowClosed(win: Window): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (win.closed) {
        clearInterval(poll);
        setTimeout(resolve, 3000);
      }
    }, 1000);
  });
}

/**
 * Last popup window opened on the web path. Tracked so `closeOAuthSurface`
 * can dismiss it once the backend confirms the connection — Composio's
 * hosted success page doesn't close itself.
 */
let webWin: Window | null = null;

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
  // `window.open` returns null when the browser blocked the popup.
  // Throw rather than returning a Promise that never resolves — the
  // calling component would otherwise spin its "Connecting…" UI
  // indefinitely with no way to recover. Callers should catch this and
  // reset their busy state (and optionally tell the user to retry /
  // unblock popups).
  const win = window.open(url, "_blank");
  if (!win) throw new PopupBlockedError();
  webWin = win;
  return windowClosed(win);
}

/**
 * Programmatically dismiss the OAuth surface opened by the most recent
 * `openOAuthAndAwaitClose` call.
 *
 * Composio's OAuth `link()` carries no app deep-link callback (unlike
 * Supabase auth, which redirects to `ai.pin.proactive://auth/callback` so
 * `appUrlOpen` can close the browser — see hooks/useAuth.ts). After the
 * user authorizes, the in-app browser (native) / popup (web) just sits on
 * Composio's hosted "you can close this" page. Callers that poll the
 * backend for ACTIVE status call this once confirmed so the surface
 * auto-closes instead of waiting for a manual dismiss.
 *
 * Native: closes `@capacitor/browser` (fires `browserFinished`, which
 * tears down the listener registered above). Web: closes the popup we
 * opened — no-op if it was already closed or never opened.
 */
export async function closeOAuthSurface(): Promise<void> {
  if (isNative) {
    await Browser.close();
    return;
  }
  webWin?.close();
  webWin = null;
}
