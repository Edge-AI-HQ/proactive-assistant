/**
 * Pipeline hook for the cloud frontend.
 * Adapted from proactive-ai/src/ui/hooks/use-pipeline.ts.
 * Uses proxyFetch for all container API calls.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { proxyFetch } from "@/lib/api";
import {
  normalizeIntentCards,
  type IntentCard,
  type EvaluationScore,
} from "@/types/intent-card";

export type { IntentCard, EvaluationScore };

const STORAGE_KEY = "proactive-ai-run-state";
const HEALTH_FAILURE_THRESHOLD = 3;

export interface LogEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
  timestamp: string;
}

export type PipelinePhase = "planning" | "generating" | "evaluating" | "complete";
export type RunStatus = "idle" | "connecting" | "running" | "complete" | "error";

export interface RunState {
  runId: string | null;
  status: RunStatus;
  activePhase: PipelinePhase | null;
  startedAt: string | null;
  completedAt: string | null;
  finalCards: IntentCard[];
  scoreMap: Record<string, EvaluationScore>;
  logEntries: LogEntry[];
  error: string | null;
  /**
   * Agent's batch-level commentary, populated by /runs/:id. Most useful when
   * `status='complete' && finalCards.length===0` so the UI can explain why
   * the agent declined to generate (e.g., "no connected toolkits yet" or
   * "G3 genericness filter rejected all candidates"). null when the agent
   * didn't emit one or the run hasn't completed.
   */
  batchFeedback: string | null;
}

export interface HealthState {
  loading: boolean;
  ok: boolean;
  pipelineRunning: boolean;
  error: string | null;
}

function makeLogEntry(kind: string, title: string, detail: string, extra?: Partial<LogEntry>): LogEntry {
  return {
    id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind, title, detail,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function createInitialRunState(): RunState {
  return {
    runId: null,
    status: "idle", activePhase: null,
    startedAt: null, completedAt: null, finalCards: [],
    scoreMap: {}, logEntries: [], error: null,
    batchFeedback: null,
  };
}

function saveRunState(run: RunState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(run));
  } catch (err) {
    console.warn("[usePipeline] sessionStorage write failed:", err);
  }
}

function isRunState(value: unknown): value is RunState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.status === "string" &&
    Array.isArray(v.finalCards) &&
    typeof v.scoreMap === "object" &&
    Array.isArray(v.logEntries)
  );
}

function loadRunState(): RunState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRunState(parsed)) {
      console.warn("[usePipeline] Discarding corrupt sessionStorage state");
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return {
      ...parsed,
      finalCards: normalizeIntentCards(parsed.finalCards),
      // Older sessionStorage entries may not have batchFeedback; default
      // to null instead of leaving it undefined.
      batchFeedback: typeof parsed.batchFeedback === "string" ? parsed.batchFeedback : null,
    };
  } catch {
    return null;
  }
}

function isActiveRunStatus(status: RunStatus): boolean {
  return status === "running" || status === "connecting";
}

export function usePipeline() {
  const sourceRef = useRef<AbortController | null>(null);
  const healthFailuresRef = useRef(0);
  const [health, setHealth] = useState<HealthState>({
    loading: true, ok: false, pipelineRunning: false, error: null,
  });
  const [run, setRun] = useState<RunState>(() => loadRunState() ?? createInitialRunState());

  useEffect(() => { saveRunState(run); }, [run]);

  useEffect(() => {
    if (health.loading || health.pipelineRunning) return;

    setRun((prev) => {
      if (!isActiveRunStatus(prev.status) || sourceRef.current) return prev;

      if (prev.finalCards.length > 0) {
        return {
          ...prev,
          status: "complete",
          activePhase: "complete",
          completedAt: prev.completedAt ?? new Date().toISOString(),
          error: null,
          logEntries: [
            makeLogEntry("system", "Run settled", "Backend is no longer running; keeping recovered cards"),
            ...prev.logEntries,
          ].slice(0, 80),
        };
      }

      return {
        ...prev,
        status: "idle",
        activePhase: null,
        error: null,
        completedAt: prev.completedAt ?? new Date().toISOString(),
        logEntries: [
          makeLogEntry("system", "Run settled", "Backend is no longer running"),
          ...prev.logEntries,
        ].slice(0, 80),
      };
    });
  }, [health.loading, health.pipelineRunning]);

  // Health polling via proxy
  useEffect(() => {
    const controller = new AbortController();
    async function loadHealth() {
      try {
        const res = await proxyFetch("/health", { signal: controller.signal });
        if (!res.ok) throw new Error(`Health check failed (${res.status})`);
        const data = await res.json();
        if (controller.signal.aborted) return;
        healthFailuresRef.current = 0;
        setHealth({ loading: false, ok: Boolean(data.ok), pipelineRunning: Boolean(data.pipelineRunning), error: null });
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        healthFailuresRef.current += 1;
        setHealth((prev) => {
          if (prev.ok && healthFailuresRef.current < HEALTH_FAILURE_THRESHOLD) {
            return { ...prev, loading: false, error: null };
          }
          return { loading: false, ok: false, pipelineRunning: false, error };
        });
      }
    }
    loadHealth();
    const interval = window.setInterval(loadHealth, 15_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, []);

  // On mount: check /api/status to recover from refresh
  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await proxyFetch("/status");
        if (!res.ok) return;
        const data = await res.json();

        if (data.pipelineRunning && run.status !== "running") {
          setRun((prev) => ({
            ...prev,
            status: "running",
            activePhase: data.phase ?? prev.activePhase,
          }));
          appendLog(makeLogEntry("system", "Reconnected", "Pipeline is still running on the backend"));
        } else if (!data.pipelineRunning && data.lastResult && run.status !== "complete" && run.finalCards.length === 0) {
          const recoveredCards = normalizeIntentCards(data.lastResult.finalCards);
          const recoveredFeedback =
            typeof data.lastResult.batchFeedback === "string"
              ? data.lastResult.batchFeedback
              : null;
          setRun((prev) => ({
            ...prev,
            runId: data.lastResult.id ?? prev.runId,
            status: "complete",
            activePhase: "complete",
            finalCards: recoveredCards,
            batchFeedback: recoveredFeedback,
            completedAt: data.lastResult.completedAt ?? new Date().toISOString(),
          }));
          appendLog(makeLogEntry("system", "Recovered results", `${recoveredCards.length} cards from previous run`));
        }
      } catch (err) { console.warn("[usePipeline] /status check failed:", err); }
    }
    checkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appendLog = useCallback((entry: LogEntry) => {
    setRun((prev) => ({ ...prev, logEntries: [entry, ...prev.logEntries].slice(0, 80) }));
  }, []);

  const closeSource = useCallback(() => {
    if (sourceRef.current) { sourceRef.current.abort(); sourceRef.current = null; }
  }, []);

  /**
   * Kick off a generate run and follow it via /runs/:id polling.
   *
   * Backend flow (durable pipeline runs):
   *   1. POST /generate returns { runId, status }:
   *      - 200 { status: 'completed', cards } when the agent finished within
   *        the fast-path window — render cards immediately.
   *      - 202 { status: 'running' | 'reconciling' } when the agent is still
   *        running in the background. We poll /runs/:id until it's terminal.
   *      - 409 means another run is already in flight; surface as error.
   *   2. Poll /runs/:id every 2s. Stop on status='completed' (success) or
   *      'failed' (error). Polling is best-effort: closeSource() (called by
   *      generate() on next click, or by component unmount) cancels in-flight
   *      requests and skips further ticks.
   */
  const generate = useCallback(() => {
    if (sourceRef.current) closeSource();

    const freshState: RunState = {
      ...createInitialRunState(),
      status: "connecting",
      startedAt: new Date().toISOString(),
      logEntries: [
        makeLogEntry("system", "Dispatching", "Requested card generation"),
      ],
    };
    setRun(freshState);
    setHealth((h) => ({ ...h, pipelineRunning: true }));

    const controller = new AbortController();
    sourceRef.current = controller;

    (async () => {
      let runId: string | null = null;
      let outcome: { finalCards: IntentCard[]; batchFeedback: string | null } | null = null;
      try {
        const res = await proxyFetch(`/generate`, {
          method: "POST",
          signal: controller.signal,
        });

        let payload: Record<string, unknown> = {};
        try {
          payload = (await res.json()) as Record<string, unknown>;
        } catch {
          /* non-JSON body — fall through to status check */
        }

        runId = typeof payload.runId === "string" ? payload.runId : null;

        if (!res.ok) {
          const errMsg =
            typeof payload.error === "string" ? payload.error : `HTTP ${res.status}`;
          setRun((prev) => ({
            ...prev,
            runId: runId ?? prev.runId,
            status: "error",
            error: errMsg,
            completedAt: new Date().toISOString(),
          }));
          appendLog(makeLogEntry("error", "Dispatch failed", errMsg));
          setHealth((h) => ({ ...h, pipelineRunning: false }));
          return;
        }

        if (payload.status === "completed") {
          // Fast path: backend finished inline. Cards aren't returned in the
          // dispatch response (only count) — fetch the run row for the
          // canonical finalCards + batchFeedback.
          const ok = await pollRunOnce(runId, controller.signal);
          if (ok) {
            outcome = { finalCards: ok.finalCards, batchFeedback: ok.batchFeedback };
          }
          setHealth((h) => ({ ...h, pipelineRunning: false }));
          return;
        }

        // Slow path: poll until terminal or aborted.
        setRun((prev) => ({
          ...prev,
          runId: runId ?? prev.runId,
          status: "running",
          activePhase: "generating",
        }));
        appendLog(
          makeLogEntry(
            "system",
            "Run queued",
            `Generation handed off to background; polling status`,
          ),
        );

        outcome = await waitForTerminal(runId, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        setRun((prev) => ({
          ...prev,
          status: "error",
          error: errMsg,
          completedAt: new Date().toISOString(),
        }));
        appendLog(makeLogEntry("error", "Generate failed", errMsg));
        setHealth((h) => ({ ...h, pipelineRunning: false }));
      } finally {
        const settled = outcome;
        if (settled && !controller.signal.aborted) {
          setRun((prev) => ({
            ...prev,
            runId: runId ?? prev.runId,
            status: "complete",
            activePhase: "complete",
            completedAt: new Date().toISOString(),
            finalCards: settled.finalCards,
            batchFeedback: settled.batchFeedback,
          }));
          appendLog(
            makeLogEntry(
              "complete",
              settled.finalCards.length > 0 ? "Pipeline complete" : "No new cards",
              settled.finalCards.length > 0
                ? `${settled.finalCards.length} card(s) ready`
                : (settled.batchFeedback ?? "Agent declined to generate this run"),
            ),
          );
        }
        if (sourceRef.current === controller) sourceRef.current = null;
      }
    })();

    async function pollRunOnce(
      runIdArg: string | null,
      signal: AbortSignal,
    ): Promise<{ status: string; finalCards: IntentCard[]; batchFeedback: string | null } | null> {
      if (!runIdArg) return null;
      try {
        const res = await proxyFetch(`/runs/${encodeURIComponent(runIdArg)}`, { signal });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data?.ok || !data?.run) return null;
        const run = data.run as Record<string, unknown>;
        const status = typeof run.status === "string" ? run.status : "unknown";
        const finalCards = normalizeIntentCards(run.finalCards);
        const batchFeedback =
          typeof run.batchFeedback === "string" ? run.batchFeedback : null;
        return { status, finalCards, batchFeedback };
      } catch {
        return null;
      }
    }

    async function waitForTerminal(
      runIdArg: string | null,
      signal: AbortSignal,
    ): Promise<{ finalCards: IntentCard[]; batchFeedback: string | null } | null> {
      if (!runIdArg) return null;
      const POLL_MS = 2_000;
      const HARD_DEADLINE_MS = Date.now() + 25 * 60_000;
      while (!signal.aborted && Date.now() < HARD_DEADLINE_MS) {
        const tick = await pollRunOnce(runIdArg, signal);
        if (signal.aborted) return null;
        if (tick) {
          if (tick.status === "completed") {
            return { finalCards: tick.finalCards, batchFeedback: tick.batchFeedback };
          }
          if (tick.status === "failed") {
            setRun((prev) => ({
              ...prev,
              status: "error",
              error: "Pipeline failed",
              completedAt: new Date().toISOString(),
            }));
            appendLog(makeLogEntry("error", "Pipeline failed", "Backend returned failed"));
            return null;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      return null;
    }
  }, [appendLog, closeSource]);

  const isRunning = run.status === "running" || run.status === "connecting";

  return { health, run, generate, isRunning, closeSource };
}
