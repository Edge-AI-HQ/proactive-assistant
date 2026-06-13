/**
 * 过渡 shim —— conversation 栈已下沉 @pin-ai/ui-web（chat/conversation/*，
 * 测试随迁；本地同步触点改 registerLocalThreadStore 注册点，main.tsx 注册）。
 * 旧路径保持可用。
 */
export { ConversationView as default } from "@pin-ai/ui-web";
