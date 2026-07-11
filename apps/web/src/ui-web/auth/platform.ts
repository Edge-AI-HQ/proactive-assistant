import { getDesktopBridge } from "./desktop-bridge";

/** Whether the app is running inside the Electron desktop shell
 *  (apps/desktop) — detected via the preload-injected bridge. */
export const isElectron = !!getDesktopBridge();

/**
 * Base URL for the backend. Single backend for the product —
 * chat / generate / memory / signals / profile / devices / payment all
 * land here.
 *
 * Web: empty string (same-origin, routed via Vite dev proxy or production
 * reverse proxy).
 * Electron: dev 跑在 electron-vite dev server 上（/api 同源 proxy，同
 * web）；打包件无同源后端，要求 VITE_PIN_API_URL。
 */
export const PIN_API_BASE: string =
  isElectron && import.meta.env.PROD
    ? (import.meta.env.VITE_PIN_API_URL as string)
    : "";

/**
 * Safe-area / keyboard CSS custom properties. Web 没有 native inset，
 * 预置 0px 合法值，保证 CSS 的 max(env(...), var(--safe-*)) fallback
 * 在 listener/env 都缺席时也拿得到值。
 * （document 存在性守卫：本模块可能被 node 环境的测试图谱引到。）
 */
if (typeof document !== "undefined") {
  document.documentElement.style.setProperty("--safe-top", "0px");
  document.documentElement.style.setProperty("--safe-bottom", "0px");
  document.documentElement.style.setProperty("--kb-height", "0px");
}
