/**
 * 过渡 shim —— useBrowserSession hook 已下沉 @pin-ai/state(queries/browser-session),
 * 状态机 reduce + 类型在 @pin-ai/core(domain/browser-session)。web / RN 共用。
 * 旧路径(ConversationView / frontend shim)保持可用;新代码直接 import 包。
 */
export { useBrowserSession, type UseBrowserSessionResult } from "@pin-ai/state";
export {
  type BrowserControlMode,
  type BrowserDeviceKind,
  type BrowserSession,
  type BrowserInput,
} from "@pin-ai/core";
