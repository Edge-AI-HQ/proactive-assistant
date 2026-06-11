// @pin-ai/core — 纯 TS 共用层（三端：web / Electron / Expo RN）。
// 架构与边界规则见 research/2026-06-10-frontend-layering.mdx §3-§4。
//
// transport：注入式传输（configureTransport 是 core 与平台的唯一耦合面）。
// api/*   ：按域的后端调用（从 proactive-ai-frontend lib/api.ts Phase 1 迁入）。
// domain/*：跨端域类型与 normalize（后端类型的唯一前端镜像）。

export {
  configureTransport,
  getTransportConfig,
  type TransportConfig,
} from "./transport/config";
export { readErrorMessage } from "./transport/errors";
export { pinaiFetch, proxyFetch, proxyPost } from "./transport/http";
export { proxySSE, proxyGetSSE } from "./transport/sse";

export * from "./api/account";
export * from "./api/ambient";
export * from "./api/conversation";
export * from "./api/crystallize";
export * from "./api/devices";
export * from "./api/health";
export * from "./api/memory";
export * from "./api/payment";
export * from "./api/profile";
export * from "./api/raw";
export * from "./api/reward";
export * from "./api/scheduled-generators";
export * from "./api/skills";

export * from "./domain/intent-card";
