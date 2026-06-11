/**
 * Phase 3 shim —— 状态机（history→snapshot 转换 + 状态合成）已提纯至
 * @pin-ai/core 的 machines/card-execution.ts（纯函数 + 回放测试）；React
 * 生命周期编排（reducer/轮询/bootstrap）在 @pin-ai/state 的
 * queries/card-execution.ts。旧 import 路径零改动；分层 Phase 4 统一清理。
 */
export {
  useCardExecutionRun,
  type UseCardExecutionRun,
  type UseCardExecutionRunOptions,
} from "@pin-ai/state";
export {
  type DangerousAction,
  type ExecuteArtifact,
  type ExecutionStep,
  type LastMessagePayload,
  type PendingInput,
  type RunResult,
  type RunSnapshot,
  type RunStatus,
  type SSEEvent,
  type SideEffect,
} from "@pin-ai/core";
