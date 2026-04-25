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
  type EvaluatorOutput,
} from "@/types/intent-card";

export type { IntentCard, EvaluationScore, EvaluatorOutput };

const STORAGE_KEY = "proactive-ai-run-state";
const HEALTH_FAILURE_THRESHOLD = 3;

export interface LogEntry {
  id: string;
  kind: string;
  title: string;
  detail: string;
  timestamp: string;
  iteration?: number;
}

export type PipelinePhase = "planning" | "generating" | "evaluating" | "complete";
export type RunStatus = "idle" | "connecting" | "running" | "complete" | "error";

export interface RunState {
  runId: string | null;
  status: RunStatus;
  maxIterations: number | null;
  activeIteration: number | null;
  activePhase: PipelinePhase | null;
  startedAt: string | null;
  completedAt: string | null;
  finalCards: IntentCard[];
  iterationDetails: Record<number, { cards?: IntentCard[]; evaluation?: EvaluatorOutput }>;
  scoreMap: Record<string, EvaluationScore>;
  logEntries: LogEntry[];
  error: string | null;
  totalIterations: number;
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
    status: "idle", maxIterations: null, activeIteration: null, activePhase: null,
    startedAt: null, completedAt: null, finalCards: [], iterationDetails: {},
    scoreMap: {}, logEntries: [], error: null, totalIterations: 0,
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
      iterationDetails: Object.fromEntries(
        Object.entries(parsed.iterationDetails ?? {}).map(([key, value]) => [
          key,
          {
            ...value,
            cards: normalizeIntentCards(value?.cards),
          },
        ]),
      ),
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
        activeIteration: null,
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
            activeIteration: data.iteration ?? prev.activeIteration,
          }));
          appendLog(makeLogEntry("system", "Reconnected", "Pipeline is still running on the backend"));
        } else if (!data.pipelineRunning && data.lastResult && run.status !== "complete" && run.finalCards.length === 0) {
          setRun((prev) => ({
            ...prev,
            runId: data.lastResult.id ?? prev.runId,
            status: "complete",
            activePhase: "complete",
            finalCards: normalizeIntentCards(data.lastResult.finalCards),
            totalIterations: data.lastResult.totalIterations ?? 0,
            completedAt: data.lastResult.completedAt ?? new Date().toISOString(),
          }));
          appendLog(makeLogEntry("system", "Recovered results", `${data.lastResult.finalCards?.length ?? 0} cards from previous run`));
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

  const generate = useCallback((iterations: number = 1) => {
    if (sourceRef.current) closeSource();

    const freshState: RunState = {
      ...createInitialRunState(),
      status: "connecting",
      startedAt: new Date().toISOString(),
      logEntries: [makeLogEntry("system", "Opening stream", `Requested ${iterations} iterations`)],
    };
    setRun(freshState);
    setHealth((h) => ({ ...h, pipelineRunning: true }));

    const controller = new AbortController();
    sourceRef.current = controller;

    (async () => {
      try {
        const res = await proxyFetch(`/generate?iterations=${iterations}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          setRun((prev) => ({ ...prev, status: "error", error: text || `HTTP ${res.status}` }));
          setHealth((h) => ({ ...h, pipelineRunning: false }));
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              handleEvent(event);
            } catch (err) {
              appendLog(makeLogEntry("error", "Event parse error", err instanceof Error ? err.message : String(err)));
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        // Try to recover from status endpoint
        try {
          const res = await proxyFetch("/status");
          const data = await res.json();
          if (data.lastResult?.finalCards?.length > 0) {
            setRun((prev) => ({
              ...prev, runId: data.lastResult.id ?? prev.runId, status: "complete", activePhase: "complete",
              finalCards: normalizeIntentCards(data.lastResult.finalCards),
              totalIterations: data.lastResult.totalIterations,
              completedAt: data.lastResult.completedAt,
            }));
            appendLog(makeLogEntry("complete", "Pipeline complete", `${data.lastResult.finalCards.length} cards (recovered)`));
            setHealth((h) => ({ ...h, pipelineRunning: false }));
            return;
          }
        } catch { /* recovery fetch also failed — fall through to error state */ }

        setRun((prev) => ({
          ...prev, status: "error",
          error: err instanceof Error ? err.message : "Connection lost",
        }));
        setHealth((h) => ({ ...h, pipelineRunning: false }));
      }
    })();

    function handleEvent(event: { type: string; data: Record<string, unknown> }) {
      switch (event.type) {
        case "pipeline:start":
          setRun((prev) => ({ ...prev, status: "running", maxIterations: event.data.maxIterations as number, activeIteration: 1, activePhase: "planning" }));
          appendLog(makeLogEntry("system", "Pipeline started", `Max ${event.data.maxIterations} iterations`));
          break;
        case "pipeline:iteration":
          setRun((prev) => ({ ...prev, status: "running", activeIteration: event.data.iteration as number, activePhase: event.data.phase as PipelinePhase }));
          appendLog(makeLogEntry(event.data.phase as string, `Iteration ${event.data.iteration}`, event.data.phase as string, { iteration: event.data.iteration as number }));
          break;
        case "pipeline:cards":
          setRun((prev) => ({
            ...prev,
            iterationDetails: {
              ...prev.iterationDetails,
              [event.data.iteration as number]: {
                ...(prev.iterationDetails[event.data.iteration as number] || {}),
                cards: normalizeIntentCards(event.data.cards),
              },
            },
          }));
          appendLog(makeLogEntry("cards", `Iteration ${event.data.iteration} cards`, `${normalizeIntentCards(event.data.cards).length} cards generated`, { iteration: event.data.iteration as number }));
          break;
        case "pipeline:evaluation": {
          setRun((prev) => {
            const nextScoreMap = { ...prev.scoreMap };
            const evaluation = event.data.evaluation as EvaluatorOutput;
            evaluation.evaluations.forEach((s: EvaluationScore) => { nextScoreMap[s.cardId] = s; });
            return {
              ...prev,
              iterationDetails: { ...prev.iterationDetails, [event.data.iteration as number]: { ...(prev.iterationDetails[event.data.iteration as number] || {}), evaluation } },
              scoreMap: nextScoreMap,
            };
          });
          const evaluation = event.data.evaluation as EvaluatorOutput;
          const passCount = evaluation.evaluations.filter((e: EvaluationScore) => e.pass).length;
          appendLog(makeLogEntry("evaluation", `Iteration ${event.data.iteration} evaluation`, `${passCount}/${evaluation.evaluations.length} cards passed`, { iteration: event.data.iteration as number }));
          break;
        }
        case "pipeline:complete":
          setRun((prev) => ({
            ...prev,
            runId: (event.data.runId as string) ?? prev.runId,
            status: "complete", activePhase: "complete",
            completedAt: new Date().toISOString(),
            finalCards: normalizeIntentCards(event.data.finalCards),
            totalIterations: event.data.totalIterations as number,
          }));
          appendLog(makeLogEntry("complete", "Pipeline complete", `${normalizeIntentCards(event.data.finalCards).length} cards selected after ${event.data.totalIterations} iterations`));
          setHealth((h) => ({ ...h, pipelineRunning: false }));
          closeSource();
          break;
        case "pipeline:error":
          setRun((prev) => ({ ...prev, status: "error", error: (event.data.message as string) || "Pipeline failed", completedAt: new Date().toISOString() }));
          appendLog(makeLogEntry("error", "Pipeline error", (event.data.message as string) || "Pipeline failed"));
          setHealth((h) => ({ ...h, pipelineRunning: false }));
          closeSource();
          break;
      }
    }
  }, [appendLog, closeSource]);

  const isRunning = run.status === "running" || run.status === "connecting";

  return { health, run, generate, isRunning, closeSource };
}
