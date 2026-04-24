import { Capacitor } from "@capacitor/core";

/** Whether the app is running inside a native shell (iOS / Android). */
export const isNative = Capacitor.isNativePlatform();

/**
 * Base URL for all API requests.
 *
 * - Web: empty string (same-origin, routed via Vite proxy or reverse proxy).
 * - Native: absolute cloud URL (no same-origin available).
 */
export const API_BASE: string = isNative
  ? (import.meta.env.VITE_API_BASE_URL as string)
  : "";

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
