import { useState, useRef, useCallback, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import type {
  IntentCard,
  IntentCardAction,
  EvaluationScore,
  EvaluatorOutput,
  PipelineCompletionStatus,
  PipelineWarning,
} from "@shared/intent-card";

export type { IntentCard, IntentCardAction, EvaluationScore, EvaluatorOutput, PipelineWarning };

const STORAGE_KEY = "proactive-ai-run-state";

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
  completionStatus: PipelineCompletionStatus | null;
  warnings: PipelineWarning[];
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
    scoreMap: {}, logEntries: [], completionStatus: null, warnings: [], error: null, totalIterations: 0,
  };
}

function saveRunState(run: RunState) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(run));
  } catch { /* quota exceeded or private mode */ }
}

function loadRunState(): RunState | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as RunState;
  } catch { return null; }
}

export function usePipeline() {
  const sourceRef = useRef<AbortController | null>(null);
  const [health, setHealth] = useState<HealthState>({
    loading: true, ok: false, pipelineRunning: false, error: null,
  });
  const [run, setRun] = useState<RunState>(() => loadRunState() ?? createInitialRunState());

  // Persist run state to sessionStorage on every change
  useEffect(() => { saveRunState(run); }, [run]);

  // Health polling
  useEffect(() => {
    let mounted = true;
    async function loadHealth() {
      try {
        const res = await apiFetch("/api/health");
        if (!res.ok) throw new Error(`Health check failed (${res.status})`);
        const data = await res.json();
        if (!mounted) return;
        setHealth({ loading: false, ok: Boolean(data.ok), pipelineRunning: Boolean(data.pipelineRunning), error: null });
      } catch (err) {
        if (!mounted) return;
        setHealth({ loading: false, ok: false, pipelineRunning: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    loadHealth();
    const interval = window.setInterval(loadHealth, 15_000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, []);

  // On mount: check /api/status to recover from refresh
  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await apiFetch("/api/status");
        if (!res.ok) return;
        const data = await res.json();

        if (data.pipelineRunning && run.status !== "running") {
          // Pipeline is still running on the backend — update UI to show it
          setRun((prev) => ({
            ...prev,
            status: "running",
            activePhase: data.phase ?? prev.activePhase,
            activeIteration: data.iteration ?? prev.activeIteration,
          }));
          appendLog(makeLogEntry("system", "Reconnected", "Pipeline is still running on the backend"));
        } else if (!data.pipelineRunning && data.lastResult && run.status !== "complete" && run.finalCards.length === 0) {
          // Pipeline finished while we were disconnected — load the result
          setRun((prev) => ({
            ...prev,
            runId: data.lastResult.id ?? prev.runId,
            status: "complete",
            activePhase: "complete",
            finalCards: data.lastResult.finalCards ?? [],
            totalIterations: data.lastResult.totalIterations ?? 0,
            completionStatus: data.lastResult.completionStatus ?? "complete",
            warnings: data.lastResult.warnings ?? [],
            completedAt: data.lastResult.completedAt ?? new Date().toISOString(),
          }));
          appendLog(makeLogEntry("system", "Recovered results", `${data.lastResult.finalCards?.length ?? 0} cards from previous run`));
          if ((data.lastResult.warnings?.length ?? 0) > 0) {
            appendLog(makeLogEntry("warning", "Recovered with warnings", (data.lastResult.warnings as PipelineWarning[]).map((warning) => warning.message).join(" | ")));
          }
        }
      } catch { /* /api/status not available */ }
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
        const res = await apiFetch(`/api/generate?iterations=${iterations}`, {
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
          const res = await apiFetch("/api/status");
          const data = await res.json();
          if (data.lastResult?.finalCards?.length > 0) {
            setRun((prev) => ({
              ...prev, runId: data.lastResult.id ?? prev.runId, status: "complete", activePhase: "complete",
              finalCards: data.lastResult.finalCards,
              totalIterations: data.lastResult.totalIterations,
              completionStatus: data.lastResult.completionStatus ?? "complete",
              warnings: data.lastResult.warnings ?? [],
              completedAt: data.lastResult.completedAt,
            }));
            appendLog(makeLogEntry("complete", "Pipeline complete", `${data.lastResult.finalCards.length} cards (recovered)`));
            if ((data.lastResult.warnings?.length ?? 0) > 0) {
              appendLog(makeLogEntry("warning", "Recovered with warnings", (data.lastResult.warnings as PipelineWarning[]).map((warning) => warning.message).join(" | ")));
            }
            setHealth((h) => ({ ...h, pipelineRunning: false }));
            return;
          }
        } catch { /* fallthrough */ }

        setRun((prev) => ({
          ...prev, status: "error",
          error: err instanceof Error ? err.message : "Connection lost",
        }));
        setHealth((h) => ({ ...h, pipelineRunning: false }));
      }
    })();

    function handleEvent(event: { type: string; data: any }) {
      switch (event.type) {
        case "pipeline:start":
          setRun((prev) => ({ ...prev, status: "running", maxIterations: event.data.maxIterations, activeIteration: 1, activePhase: "planning" }));
          appendLog(makeLogEntry("system", "Pipeline started", `Max ${event.data.maxIterations} iterations`));
          break;
        case "pipeline:iteration":
          setRun((prev) => ({ ...prev, status: "running", activeIteration: event.data.iteration, activePhase: event.data.phase }));
          appendLog(makeLogEntry(event.data.phase, `Iteration ${event.data.iteration}`, event.data.phase, { iteration: event.data.iteration }));
          break;
        case "pipeline:cards":
          setRun((prev) => ({
            ...prev,
            iterationDetails: { ...prev.iterationDetails, [event.data.iteration]: { ...(prev.iterationDetails[event.data.iteration] || {}), cards: event.data.cards } },
          }));
          appendLog(makeLogEntry("cards", `Iteration ${event.data.iteration} cards`, `${event.data.cards.length} cards generated`, { iteration: event.data.iteration }));
          break;
        case "pipeline:evaluation": {
          setRun((prev) => {
            const nextScoreMap = { ...prev.scoreMap };
            event.data.evaluation.evaluations.forEach((s: EvaluationScore) => { nextScoreMap[s.cardId] = s; });
            return {
              ...prev,
              iterationDetails: { ...prev.iterationDetails, [event.data.iteration]: { ...(prev.iterationDetails[event.data.iteration] || {}), evaluation: event.data.evaluation } },
              scoreMap: nextScoreMap,
            };
          });
          const passCount = event.data.evaluation.evaluations.filter((e: EvaluationScore) => e.pass).length;
          appendLog(makeLogEntry("evaluation", `Iteration ${event.data.iteration} evaluation`, `${passCount}/${event.data.evaluation.evaluations.length} cards passed`, { iteration: event.data.iteration }));
          break;
        }
        case "pipeline:complete":
          setRun((prev) => ({
            ...prev,
            runId: event.data.runId ?? prev.runId,
            status: "complete", activePhase: "complete",
            completedAt: new Date().toISOString(),
            finalCards: event.data.finalCards,
            totalIterations: event.data.totalIterations,
            completionStatus: event.data.completionStatus ?? "complete",
            warnings: event.data.warnings ?? [],
          }));
          appendLog(makeLogEntry(
            "complete",
            event.data.completionStatus === "partial" ? "Pipeline complete (partial)" : "Pipeline complete",
            `${event.data.finalCards.length} cards selected after ${event.data.totalIterations} iterations`,
          ));
          if ((event.data.warnings?.length ?? 0) > 0) {
            appendLog(makeLogEntry("warning", "Pipeline warnings", (event.data.warnings as PipelineWarning[]).map((warning) => warning.message).join(" | ")));
          }
          setHealth((h) => ({ ...h, pipelineRunning: false }));
          closeSource();
          break;
        case "pipeline:error":
          setRun((prev) => ({ ...prev, status: "error", error: event.data.message || "Pipeline failed", completedAt: new Date().toISOString() }));
          appendLog(makeLogEntry("error", "Pipeline error", event.data.message || "Pipeline failed"));
          setHealth((h) => ({ ...h, pipelineRunning: false }));
          closeSource();
          break;
      }
    }
  }, [appendLog, closeSource]);

  const isRunning = run.status === "running" || run.status === "connecting";

  return { health, run, generate, isRunning, closeSource };
}
