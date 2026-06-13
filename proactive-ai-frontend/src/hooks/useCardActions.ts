/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（card/useCardActions，测试随迁）。
 * 签名不变（{ onOpenChat, composio }）。离线 outbox 不再由 hook 硬依赖
 * lib/sync，改 main.tsx 经 registerFeedbackOutbox 注册（ui-web 不依赖
 * 本地同步引擎）。
 */
export { useCardActions, type UseCardActionsOptions } from "@pin-ai/ui-web";
