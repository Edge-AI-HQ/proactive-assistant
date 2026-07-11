/**
 * Helper for opening a Composio OAuth URL in a popup window and resolving
 * once the user dismisses it (closed-polling).
 *
 * Previously inlined in `components/DataConnections.tsx`. Pulled out so
 * the connector-guidance card / chat chip flow can reuse the exact same
 * popup behavior without copy-pasting (or worse, drifting from) the
 * settings page logic.
 */

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
 * Composio's OAuth `link()` carries no app deep-link callback. After the
 * user authorizes, the popup just sits on Composio's hosted "you can
 * close this" page. Callers that poll the backend for ACTIVE status call
 * this once confirmed so the popup auto-closes instead of waiting for a
 * manual dismiss — no-op if it was already closed or never opened.
 */
export async function closeOAuthSurface(): Promise<void> {
  webWin?.close();
  webWin = null;
}
