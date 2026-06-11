/**
 * Phase 3 shim —— LiveContentBuilder（流式 turn 内容组装状态机）与
 * ConversationContentPart 类型已迁 @pin-ai/core 的 machines/tool-steps.ts
 * （纯 TS，三端共用）。旧 import 路径零改动；分层 Phase 4 统一清理。
 */
export {
  LiveContentBuilder,
  parseToolLinks,
  type ConversationContentPart,
  type JsonValue,
  type ToolCallArgs,
  type ToolCallSnapshotArgs,
  type ToolResultLink,
} from "@pin-ai/core";
