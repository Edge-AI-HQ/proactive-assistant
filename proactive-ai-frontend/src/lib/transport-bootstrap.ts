/**
 * 过渡 shim —— transport 组装点已下沉 @pin-ai/ui-web（web 介质下两端组装
 * 完全一致，见 ui-web 的 auth/transport-bootstrap.ts）。import 本模块仍然
 * 触发 configureTransport side effect（经 ui-web 的模块加载），与原语义
 * 一致；authHeaders / profileClientHintHeaders 旧路径照常导出。
 */
export { authHeaders, profileClientHintHeaders } from "@pin-ai/ui-web";
