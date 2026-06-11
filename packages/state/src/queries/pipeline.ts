/**
 * Pipeline hook —— generator 任务的本地 RunState 编排（分层 Phase 3）。
 *
 * 状态转移全部在 @pin-ai/core 的 machines/pipeline.ts（纯函数 + 回放
 * 测试）；本文件只剩 React 时序：mount 安全网、/status 恢复、generate
 * 的 202 dispatch、agent-runs 订阅反应、5s grace settle、孤儿采纳。
 *
 * 持久化经 `persist` 注入（web 壳传 sessionStorage 实现，RN 将传
 * AsyncStorage 同步缓存）——state 包不碰平台存储。
 */
import { useState, useRef, useCallback, useEffect } from "react";

import {
  adoptOrphanRun,
  applyDispatchAccepted,
  applyDispatchError,
  applyRunFailure,
  applyRunResult,
  applyStatusCheck,
  createInitialRunState,
  dispatchingRunState,
  findOrphanGeneratorRun,
  hasServerActiveGenerator,
  isActiveRunStatus,
  normalizeIntentCards,
  proxyFetch,
  settleStaleRun,
  settleVanishedRun,
  type ActiveAgentRun,
  type RunState,
} from "@pin-ai/core";

import { useActiveAgentRuns } from "./agent-runs";

export interface PipelinePersist {
  load: () => RunState | null;
  save: (state: RunState) => void;
}

export interface UsePipelineOptions {
  persist?: PipelinePersist;
}

export function usePipeline(options: UsePipelineOptions = {}) {
  const { persist } = options;
  const sourceRef = useRef<AbortController | null>(null);
  const [run, setRun] = useState<RunState>(
    () => persist?.load() ?? createInitialRunState(),
  );

  useEffect(() => {
    persist?.save(run);
  }, [persist, run]);

  // Page-reload safety net: if persisted state restored an active run
  // but no dispatch took over, settle back to idle (or 'complete' when
  // cards survived). Fires once on mount.
  useEffect(() => {
    setRun((prev) => (sourceRef.current ? prev : settleStaleRun(prev)));
  }, []);

  // On mount: check /api/status to recover from refresh.
  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await proxyFetch("/status");
        if (!res.ok) return;
        const data = await res.json();
        setRun((prev) => applyStatusCheck(prev, data) ?? prev);
      } catch (err) {
        console.warn("[usePipeline] /status check failed:", err);
      }
    }
    void checkStatus();
  }, []);

  // Subscribe to the global agent-runs feed. usePipeline drives RunState
  // off the `generator` kind specifically — other agents (dream, evolve,
  // etc.) are surfaced via the AgentRunIndicator pill, not here.
  const { runs, refresh: refreshAgentRuns } = useActiveAgentRuns();

  /**
   * Enqueue a generator task. Returns immediately with the task_id;
   * scheduler dispatcher does the actual LLM run. Idempotent: clicking
   * twice while a generator is already in flight is a no-op (server
   * dedupes and returns the existing task_id).
   */
  const generate = useCallback(() => {
    // Synchronous re-entrancy gate. sourceRef is set inside the same
    // event-handler tick, so a second click during React's current render
    // batch — or before /generate's POST resolves — is a true no-op.
    if (sourceRef.current) return;

    setRun(dispatchingRunState());

    const controller = new AbortController();
    sourceRef.current = controller;

    (async () => {
      try {
        const res = await proxyFetch(`/generate`, {
          method: "POST",
          signal: controller.signal,
        });

        let payload: Record<string, unknown> = {};
        try {
          payload = (await res.json()) as Record<string, unknown>;
        } catch {
          /* non-JSON body — fall through */
        }

        if (!res.ok) {
          const errMsg =
            typeof payload.error === "string" ? payload.error : `HTTP ${res.status}`;
          setRun((prev) => applyDispatchError(prev, errMsg));
          return;
        }

        setRun((prev) => applyDispatchAccepted(prev, payload));
        // Yank a fresh /agent-runs/active so the indicator pill appears
        // without waiting for the next poll tick.
        await refreshAgentRuns();
      } catch (err) {
        if (controller.signal.aborted) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        setRun((prev) => applyDispatchError(prev, errMsg));
      } finally {
        if (sourceRef.current === controller) sourceRef.current = null;
      }
    })();
  }, [refreshAgentRuns]);

  // ── React to the matched generator run finishing ────────────────────
  // We track which run id we've already settled so the same succeeded
  // row doesn't re-trigger when the indicator's 30s grace window
  // re-emits it.
  const settledRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!run.runId) return;
    const match: ActiveAgentRun | undefined = runs.find(
      (r) => r.kind === "generator.manual" && r.id === run.runId,
    );
    if (!match) return;

    if (match.status === "running" && run.status !== "running") {
      setRun((prev) => ({ ...prev, status: "running", activePhase: "generating" }));
      return;
    }

    if (match.status === "succeeded" && settledRunIdRef.current !== match.id) {
      settledRunIdRef.current = match.id;
      // Fetch the canonical pipeline row to get final cards + feedback.
      void (async () => {
        try {
          const res = await proxyFetch(`/runs/${encodeURIComponent(match.id)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const r = (data.run ?? {}) as Record<string, unknown>;
          const finalCards = normalizeIntentCards(r.finalCards);
          const batchFeedback =
            typeof r.batchFeedback === "string" ? r.batchFeedback : null;
          setRun((prev) => applyRunResult(prev, finalCards, batchFeedback));
        } catch (err) {
          setRun((prev) =>
            applyRunFailure(
              prev,
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      })();
    }

    if (match.status === "failed" && settledRunIdRef.current !== match.id) {
      settledRunIdRef.current = match.id;
      setRun((prev) => applyRunFailure(prev, match.lastError ?? "Pipeline failed"));
    }
  }, [runs, run.runId, run.status]);

  // ── F5 recovery ─────────────────────────────────────────────────────
  // If persisted state thinks a run is active but the server has no
  // matching active run, settle back to idle / complete after a short
  // grace window (covers both real F5 recovery and the dispatch race
  // before refreshAgentRuns catches up). Cleanup cancels the timer the
  // moment the run appears in the feed.
  useEffect(() => {
    if (run.status !== "running") return;
    if (!run.runId) return;
    if (runs.some((r) => r.id === run.runId)) return; // server has it
    const id = setTimeout(() => {
      setRun((prev) => settleVanishedRun(prev));
    }, 5_000);
    return () => clearTimeout(id);
  }, [runs, run.status, run.runId]);

  // ── Adopt orphan generator runs ─────────────────────────────────────
  // Across F5 the persisted state may be empty / stale, but the server
  // may already have a generator run in flight. Without this the local
  // state stays "idle" and the Generate button would re-enable, letting
  // the user race the server-side dedup.
  useEffect(() => {
    if (run.runId) return;
    if (isActiveRunStatus(run.status)) return;
    const orphan = findOrphanGeneratorRun(runs);
    if (!orphan) return;
    setRun((prev) => adoptOrphanRun(prev, orphan));
  }, [runs, run.runId, run.status]);

  const closeSource = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.abort();
      sourceRef.current = null;
    }
  }, []);

  // `isRunning` reflects server truth, not just local state — after F5
  // the Generate button stays disabled if a generator run is still
  // mid-flight on the server.
  const isRunning = isActiveRunStatus(run.status) || hasServerActiveGenerator(runs);

  return { run, generate, isRunning, closeSource };
}
