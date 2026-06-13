/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（web 介质共享层，apps/web 同源
 * 消费）。旧路径 `@/lib/platform` 保持可用；新代码直接 import
 * "@pin-ai/ui-web"。模块 side effects（--safe-top/--safe-bottom/--kb-height
 * 预置）随 re-export 照常执行。
 */
export { isNative, isElectron, PIN_API_BASE, pinApiRequestHeaders } from "@pin-ai/ui-web";
