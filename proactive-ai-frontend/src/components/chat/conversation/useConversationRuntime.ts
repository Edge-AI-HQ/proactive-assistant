/**
 * Phase 3 shim —— conversation 运行时已提纯拆分：纯逻辑（history→entries、
 * heartbeat 分类、resync 三段合并、HITL partial 重建）在 @pin-ai/core 的
 * machines/conversation.ts（回放测试锁定）；React 编排（SSE 生命周期/
 * builder 桥接/actions）在 @pin-ai/state 的 queries/conversation.ts。
 * 旧 import 路径零改动；分层 Phase 4 统一清理。
 */
export {
  useConversationRuntime,
  type ConversationRuntimeOpts,
  type UseConversationRuntimeResult,
} from "@pin-ai/state";
export {
  historyToEntries,
  partsHaveNotifyUser,
  type ConversationAssistantEntry,
  type ConversationConnectionState,
  type ConversationEntry,
  type ConversationHeartbeatEntry,
  type ConversationUserEntry,
} from "@pin-ai/core";
