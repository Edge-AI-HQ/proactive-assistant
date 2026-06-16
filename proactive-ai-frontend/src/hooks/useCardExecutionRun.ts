/**
 * Phase 3 shim —— 状态机（transcript→snapshot 转换 + 状态合成）已提纯至
 * @pin-ai/core 的 machines/card-execution.ts（纯函数 + 回放测试）；SSE
 * conversation runtime 编排（card detail 与 main chat 共用一套）在 @pin-ai/state
 * 的 queries/card-execution.ts。旧 import 路径零改动；分层 Phase 4 统一清理。
 */
import {
  useCardExecutionRun as useCardExecutionRunBase,
  type UseCardExecutionRun,
  type UseCardExecutionRunOptions,
} from "@pin-ai/state";
import { readLocalHistory } from "@/lib/sync/sync-bootstrap";

export type { UseCardExecutionRun, UseCardExecutionRunOptions };

/** B3b：壳层注入本地读（4 个组件消费者零改动）；引擎未启动时
 *  readLocalHistory 返回 null → 行为与纯网络一致。 */
export function useCardExecutionRun(
  runId: string | null,
  options: UseCardExecutionRunOptions = {},
): UseCardExecutionRun {
  return useCardExecutionRunBase(runId, {
    localHistory: readLocalHistory,
    ...options,
  });
}
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
