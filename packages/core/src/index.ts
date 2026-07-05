// @pin-ai/core — 纯 TS 共用层（三端：web / Electron / Expo RN）。
// 架构与边界规则见 research/2026-06-10-frontend-layering.mdx §3-§4。
//
// transport：注入式传输（configureTransport 是 core 与平台的唯一耦合面）。
// api/*   ：按域的后端调用（从 proactive-ai-frontend lib/api.ts Phase 1 迁入）。
// domain/*：跨端域类型与 normalize（后端类型的唯一前端镜像）。

export {
  configureTransport,
  getTransportConfig,
  resolveClientHints,
  type TransportConfig,
  type DeviceClientHints,
} from "./transport/config";
export { readErrorMessage } from "./transport/errors";
export { pinaiFetch, proxyFetch, proxyPost } from "./transport/http";
export { proxySSE, proxyGetSSE } from "./transport/sse";

export * from "./api/account";
export * from "./api/agent-runs";
export * from "./api/ambient";
export * from "./api/cards";
export * from "./api/composio";
export * from "./api/conversation";
export * from "./api/devices";
export * from "./api/events";
export * from "./api/health";
export * from "./api/payment";
export * from "./api/portrait";
export * from "./api/scheduled-generators";
export * from "./api/skills";

export * from "./domain/ambient";
export * from "./domain/ambient-transcript-clean";
export * from "./domain/card-actions";
export * from "./domain/card-chat-session";
export * from "./domain/card-context";
export * from "./domain/card-feedback";
export * from "./domain/card-run-status";
export * from "./domain/cards";
export * from "./domain/composio";
export * from "./domain/composio-identity";
export * from "./domain/dev-auth";
export * from "./domain/work-group";
export * from "./domain/chat-feedback";
export * from "./domain/device-timeline-filters";
export * from "./domain/hitl-approval";
export * from "./domain/intent-card";
export * from "./domain/markdown-blocks";
export * from "./domain/reminder-card";
export * from "./domain/signals";
export * from "./domain/voice-language";
export * from "./domain/voice-stream";
export * from "./domain/voice-identity-api";
export * from "./domain/basket-category";
export * from "./domain/source-app";
export * from "./domain/tool-presentation";
export * from "./domain/lovable-card";
export * from "./domain/weather";
export * from "./domain/browser-session";
export * from "./domain/browser-login";
export * from "./domain/connector-toolkit";
export * from "./domain/connector-card";
export * from "./domain/ui-language";

export * from "./machines/card-execution";
export * from "./machines/conversation";
export * from "./machines/pipeline";
export * from "./machines/tool-steps";

export * from "./ports/database";
export * from "./ports/sign-out-cleanup";
export * from "./ports/feedback-outbox";
export * from "./ports/local-thread-store";
export * from "./ports/external-mic";

export * from "./sync/ambient-outbox";
export * from "./sync/ingest-buckets";
export * from "./sync/sqlite-outbox";
export * from "./sync/engine";
export * from "./sync/local-read";
export * from "./sync/outbox";
export * from "./sync/scheduler";
export * from "./sync/search";
export * from "./sync/schema";
