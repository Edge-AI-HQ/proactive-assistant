/**
 * Phase 1 shim —— API client 实现已迁入 @pin-ai/core（分层方案
 * research/2026-06-10-frontend-layering.mdx §5 Phase 1）。
 *
 * 旧 import 路径（`@/lib/api`）零改动：本文件全量转发 core 的导出，并
 * re-export 留在 app 侧的平台实现（authHeaders / profileClientHintHeaders，
 * 它们依赖 supabase / navigator）。import 本文件即触发 transport-bootstrap
 * 的 configureTransport（auth 注入）。
 *
 * 组件 import 按域逐步改到 @pin-ai/core 后删除本文件（分层 Phase 4）。
 */
export * from "@pin-ai/core";
export { authHeaders, profileClientHintHeaders } from "./transport-bootstrap";
