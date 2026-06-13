/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（connect/useComposio，测试随迁）。
 * 旧路径保持可用；新代码直接 import "@pin-ai/ui-web"。
 */
export {
  useComposio,
  buildConnectorInitTaskId,
  buildConnectorPreviewTaskId,
  normalizeComposioToolkit,
  composioToolkitCovers,
  getComposioConnectionsForToolkit,
  isComposioToolkitConnected,
  type ComposioState,
  type ComposioStatus,
  type Connection,
  type ComposioCatalogItem,
  type ComposioCatalogPage,
  type ComposioCustomAuthScheme,
  type ComposioCustomAuthConfig,
  type ConnectToolkitOptions,
  type CustomMcpConnector,
  type CustomMcpConnectorResult,
} from "@pin-ai/state";
