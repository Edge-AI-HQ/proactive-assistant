/**
 * Browser session(agent browser tool 的远端浏览器)状态机 + 类型。平台无关。
 *
 * SSE 连接 / 心跳 / 命令的 hook 在 state/queries/browser-session(用 core
 * transport,web / RN 共用);这里只放纯状态机:envelope → BrowserSession 归约。
 */

export type BrowserControlMode = "ai" | "user";
export type BrowserDeviceKind = "mobile" | "tablet" | "desktop";

export interface BrowserSession {
  sessionKey: string;
  bbSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  /** Stealth UA profile the remote browser was launched with. Drives
   *  whether the live-view is rendered fit-to-width (mobile / tablet —
   *  wants natural vertical scroll) or fit-to-height (desktop — wants the
   *  full chrome visible). Defaults to "desktop" on the legacy code path
   *  that never emits it. */
  deviceKind: BrowserDeviceKind;
  controlMode: BrowserControlMode;
  /** Set by AI calling `request_takeover`; cleared when control returns to AI. */
  takeoverReason: string | null;
  currentUrl: string;
}

export interface BrowserEnvelope {
  type: string;
  data?: Record<string, unknown>;
}

export type BrowserInput =
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "tap"; x: number; y: number }
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" };

export function parseControlMode(value: unknown): BrowserControlMode {
  return value === "user" ? "user" : "ai";
}

export function parseDeviceKind(value: unknown): BrowserDeviceKind {
  return value === "mobile" || value === "tablet" ? value : "desktop";
}

/** 远端浏览器事件 envelope → 新 session 状态(opened / closed / navigated /
 *  control:granted / control:takeover);不认的事件原样返回 prev。 */
export function reduceBrowserSession(
  prev: BrowserSession | null,
  ev: BrowserEnvelope,
): BrowserSession | null {
  const data = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "browser:opened": {
      const sessionKey = String(data.sessionKey ?? "");
      const bbSessionId = String(data.bbSessionId ?? "");
      const liveViewUrl = String(data.liveViewUrl ?? "");
      if (!sessionKey || !bbSessionId) return prev;
      const viewport =
        (data.viewport as { width: number; height: number }) ?? { width: 1280, height: 720 };
      return {
        sessionKey,
        bbSessionId,
        liveViewUrl,
        viewport,
        deviceKind: parseDeviceKind(data.deviceKind),
        controlMode: parseControlMode(data.controlMode),
        takeoverReason:
          typeof data.takeoverReason === "string" && data.takeoverReason
            ? data.takeoverReason
            : null,
        currentUrl: typeof data.url === "string" ? data.url : "",
      };
    }
    case "browser:closed":
      return null;
    case "browser:navigated":
      if (!prev) return prev;
      return { ...prev, currentUrl: typeof data.url === "string" ? data.url : prev.currentUrl };
    case "browser:control:granted":
    case "browser:control:takeover": {
      if (!prev) return prev;
      const mode = parseControlMode(data.controlMode);
      const reason = typeof data.reason === "string" && data.reason ? data.reason : null;
      return {
        ...prev,
        controlMode: mode,
        takeoverReason: ev.type === "browser:control:takeover" ? reason : null,
      };
    }
    default:
      return prev;
  }
}
