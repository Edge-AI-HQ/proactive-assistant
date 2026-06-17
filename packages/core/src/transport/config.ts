/**
 * Transport 配置注入点 —— core 与平台的唯一耦合面。
 *
 * core 不 import supabase / capacitor / import.meta.env：auth、baseUrl、
 * 平台 headers、fetch 实现全部由各端入口（composition root）注入。
 * web 端的注入实现在 proactive-ai-frontend/src/lib/transport-bootstrap.ts；
 * 未来 Electron / Expo RN 各自注入（RN 传 expo/fetch 解 SSE 流式雷）。
 * 设计 SSOT：research/2026-06-10-frontend-layering.mdx §4.2-§4.3。
 */

/** 显示设备 hints —— 随每个 chat send 进 body 给后端 browser_tool 用。
 *  snake_case 与后端 ClientHintsBody 字段一致，整条 opaque 透传。 */
export interface DeviceClientHints {
  viewport_width: number;
  viewport_height: number;
  device_kind: "mobile" | "tablet" | "desktop";
}

export interface TransportConfig {
  /** 后端基址。web 同源传 ""；native/RN 传绝对 URL（如 ngrok / fly）。 */
  baseUrl: string;
  /** 每请求的 auth headers（Supabase Bearer / X-Dev-Auth / 空对象）。 */
  getAuthHeaders: () => Promise<Record<string, string>>;
  /**
   * 401 时调用一次，返回新 Bearer token；返回 null 表示刷新失败，
   * 不重试（原 401 response 原样返回给调用方）。
   * 实现方负责并发去重（gotrue refresh token 是单次使用的）。
   */
  refreshAuth?: () => Promise<string | null>;
  /**
   * 认证态不可恢复时调用一次：带 auth 的请求收到 401，且 refreshAuth 也
   * 无法续期（返回 null / 刷新后仍 401）——意味着这个 session 已经死了，
   * 不是网络抖动。平台据此做全局收口（web/native: 清本地态 + 回登录页），
   * 避免 stale user 卡在「连不上服务器」错误屏。实现方负责幂等（并发请求
   * 会触发多次）。未注入则退化为旧行为（原 401 原样返回）。
   */
  onAuthInvalid?: () => void;
  /** 平台附加 headers（如 ngrok-skip-browser-warning），垫在最底层。 */
  defaultHeaders?: Record<string, string>;
  /** 客户端环境 hints（locale/timezone），/profile、/settings 用。平台各异。 */
  clientHintHeaders?: () => Record<string, string>;
  /** 显示设备 hints（panel CSS 尺寸 + 设备类型），随 chat send 进 body —— 后端
   *  browser_tool 据此给 BB 远程浏览器选 viewport + mobile/tablet/desktop UA。
   *  平台各异（web 从 window 探测）；返回 null 则不带。 */
  getClientHints?: () => DeviceClientHints | null;
  /** fetch 实现。默认 globalThis.fetch；RN 注入 expo/fetch（流式 SSE 必需）。 */
  fetchImpl?: typeof fetch;
}

let config: TransportConfig | null = null;

export function configureTransport(next: TransportConfig): void {
  config = next;
}

export function getTransportConfig(): TransportConfig {
  if (!config) {
    throw new Error(
      "[@pin-ai/core] transport not configured — call configureTransport() at app bootstrap " +
        "(web: src/lib/transport-bootstrap.ts) before any API call.",
    );
  }
  return config;
}

/** Best-effort device hints — null when transport isn't configured (unit
 *  tests / pre-bootstrap) or the platform doesn't probe. Unlike
 *  getTransportConfig() this never throws: hints are an optional enhancement
 *  (remote-browser sizing), not a hard requirement of a request. */
export function resolveClientHints(): DeviceClientHints | null {
  return config?.getClientHints?.() ?? null;
}

/** 解析 fetch 实现；默认分支以 method-call 形式调 globalThis.fetch，避免裸引用丢 this。 */
export function resolveFetch(): typeof fetch {
  const impl = getTransportConfig().fetchImpl;
  if (impl) return impl;
  return (input, init) => globalThis.fetch(input, init);
}
