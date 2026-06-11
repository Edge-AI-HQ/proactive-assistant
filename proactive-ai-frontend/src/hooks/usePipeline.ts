/**
 * Phase 3 shim —— 状态转移已提纯至 @pin-ai/core 的 machines/pipeline.ts
 * （纯函数 + 回放测试），React 编排在 @pin-ai/state 的 queries/pipeline.ts。
 * 本壳只注入 web 平台的 sessionStorage 持久化；分层 Phase 4 统一清理。
 */
import { useMemo } from "react";
import { usePipeline as usePipelineBase } from "@pin-ai/state";
import {
  parseStoredRunState,
  type EvaluationScore,
  type IntentCard,
  type RunState,
} from "@pin-ai/core";

export type { IntentCard, EvaluationScore };
export type {
  LogEntry,
  PipelinePhase,
  PipelineRunStatus as RunStatus,
  RunState,
} from "@pin-ai/core";

const STORAGE_KEY = "proactive-ai-run-state";

function loadRunState(): RunState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = parseStoredRunState(raw);
    if (raw && parsed === null) {
      console.warn("[usePipeline] Discarding corrupt sessionStorage state");
      sessionStorage.removeItem(STORAGE_KEY);
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveRunState(state: RunState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("[usePipeline] sessionStorage write failed:", err);
  }
}

export function usePipeline() {
  const persist = useMemo(
    () => ({ load: loadRunState, save: saveRunState }),
    [],
  );
  return usePipelineBase({ persist });
}
