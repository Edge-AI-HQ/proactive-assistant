/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（connect/connector-card）。
 */
export {
  isConnectorCard,
  connectorSlugFromIntentKey,
  canonicalConnectorSlugFromIntentKey,
  triggerConnectorOAuth,
  prepareConnectorOAuth,
  openPreparedConnectorOAuth,
  tryHandleConnectorCard,
  type PreparedConnectorOAuth,
} from "@pin-ai/ui-web";
