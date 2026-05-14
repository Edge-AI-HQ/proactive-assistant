import { Capacitor } from "@capacitor/core";

/** Whether the app is running inside a native shell (iOS / Android). */
export const isNative = Capacitor.isNativePlatform();

/**
 * Base URL for the pinai-agents backend. Single backend for the product —
 * chat / generate / memory / signals / profile / devices / payment all
 * land here.
 *
 * Web: empty string (same-origin, routed via Vite dev proxy or production
 * reverse proxy).
 * Native: absolute cloud URL via VITE_PIN_API_URL.
 */
export const PIN_API_BASE: string = isNative
  ? (import.meta.env.VITE_PIN_API_URL as string)
  : "";

function isNgrokUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".ngrok-free.dev")
      || host.endsWith(".ngrok.app")
      || host.endsWith(".ngrok.io");
  } catch {
    return false;
  }
}

const nativeBackendHeaders: Record<string, string> =
  isNative && isNgrokUrl(PIN_API_BASE)
    ? { "ngrok-skip-browser-warning": "1" }
    : {};

export function pinApiRequestHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  return {
    ...nativeBackendHeaders,
    ...headers,
  };
}

/**
 * Set CSS custom property for safe-area bottom inset.
 * env(safe-area-inset-bottom) returns 0 in Capacitor WKWebView,
 * so we detect the platform and apply a known value.
 *
 * Always set --safe-bottom so the CSS max() fallback works on every platform.
 */
const platform = Capacitor.getPlatform(); // "ios" | "android" | "web"
const safeBottom =
  platform === "ios" ? "34px" : platform === "android" ? "12px" : "0px";
document.documentElement.style.setProperty("--safe-bottom", safeBottom);
// --kb-height 在键盘弹起时由 main.tsx 的 keyboard listener 更新，静息状态 0px。
// 预置在这里是为了 CSS 即便在 listener 绑定前引用也拿得到合法值。
document.documentElement.style.setProperty("--kb-height", "0px");

// Log platform info for debugging native issues
if (isNative) {
  console.log(
    `[platform] native=${isNative}, platform=${platform}, safeBottom=${safeBottom}`,
  );
}
