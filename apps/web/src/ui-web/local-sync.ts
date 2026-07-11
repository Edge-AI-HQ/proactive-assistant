/**
 * 过渡 shim —— 本地同步注入点已下沉 @pin-ai/core(ports/local-thread-store),
 * 平台无关。ui-web 内部消费(ConversationView / useCardExecutionRun)+ app 注册经此零改。
 */
export {
  registerLocalThreadStore,
  notifyThreadActivity,
  readLocalHistory,
  type LocalThreadStore,
} from "@pin-ai/core";
