/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（debug/DebugPanel，连同
 * SkillsPanel / MemoriesPanel 一并下沉）。
 * 旧路径保持可用；DebugPanel 现支持可选受控（open/onOpenChange/hideTrigger），
 * AppLayout 不传即原自管行为。
 */
export { DebugPanel as default } from "@pin-ai/ui-web";
