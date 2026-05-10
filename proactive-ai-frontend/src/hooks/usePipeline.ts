/**
 * Pipeline hook for the cloud frontend.
 *
 * Phase 1 architecture: the generator runs as a `generator` task in the
 * scheduler. This hook owns the local RunState (cards, logs, status)
 * but no longer drives its own polling loop — it subscribes to
 * useActiveAgentRuns and reacts when the matching generator run
 * transitions. F5 mid-run keeps everything intact because
 * useActiveAgentRuns hydrates from `/api/agent-runs/active`.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { proxyFetch } from "@/lib/api";
import { useActiveAgentRuns, type ActiveAgentRun } from "@/hooks/useActiveAgentRuns";
import {
  normalizeIntentCards,
  type IntentCard,
  type EvaluationScore,
} from "@/types/intent-card";

export type { IntentCard, EvaluationScore };

const STORAGE_KEY = "proactive-ai-run-state";

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
  const [run, setRun] = useState<RunState>(() => loadRunState() ?? createInitialRunState());

  useEffect(() => { saveRunState(run); }, [run]);

  // Page-reload safety net: if localStorage restored an active run
  // but no SSE connection took over, settle back to idle (or
  // 'complete' when cards survived). Fires once on mount.
  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        } else if (!data.pipelineRunning && data.latestRun?.status === "failed" && run.status !== "error") {
          setRun((prev) => ({
            ...prev,
            runId: typeof data.latestRun.id === "string" ? data.latestRun.id : prev.runId,
            status: "error",
            activePhase: null,
            finalCards: [],
            error: typeof data.latestRun.error === "string" ? data.latestRun.error : "Pipeline failed",
            completedAt:
              typeof data.latestRun.completedAt === "string"
                ? data.latestRun.completedAt
                : new Date().toISOString(),
          }));
          appendLog(
            makeLogEntry(
              "error",
              "Pipeline failed",
              typeof data.latestRun.error === "string" ? data.latestRun.error : "Backend returned failed",
            ),
          );
        } else if (
          !data.pipelineRunning &&
          data.lastResult &&
          (!data.latestRun || data.latestRun.status === "completed") &&
          run.status !== "complete" &&
          run.finalCards.length === 0
        ) {
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
    // event-handler tick (below), so a second click during React's
    // current render batch — or before /generate's POST resolves — hits
    // this branch and is a true no-op (no aborted-POST noise, no double
    // dispatch on the server). The `disabled={isRunning}` on the button
    // already prevents most double-clicks, but only after the render
    // commits; this ref closes the same-tick window.
    if (sourceRef.current) return;

    const freshState: RunState = {
      ...createInitialRunState(),
      status: "connecting",
      startedAt: new Date().toISOString(),
      logEntries: [
        makeLogEntry("system", "Dispatching", "Requested card generation"),
      ],
    };
    setRun(freshState);

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
          setRun((prev) => ({
            ...prev,
            status: "error",
            error: errMsg,
            completedAt: new Date().toISOString(),
          }));
          appendLog(makeLogEntry("error", "Dispatch failed", errMsg));
          return;
        }

        const taskId =
          typeof payload.taskId === "string"
            ? payload.taskId
            : typeof payload.runId === "string"
              ? payload.runId
              : null;
        const deduped = payload.deduped === true;

        setRun((prev) => ({
          ...prev,
          runId: taskId ?? prev.runId,
          status: "running",
          activePhase: "generating",
        }));
        appendLog(
          makeLogEntry(
            "system",
            deduped ? "Already running" : "Run queued",
            deduped
              ? "An existing generator run is in flight; following it"
              : `taskId=${taskId ?? "?"}`,
          ),
        );

        // Yank a fresh /agent-runs/active so the indicator pill appears
        // without waiting for the next poll tick.
        await refreshAgentRuns();
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
      } finally {
        if (sourceRef.current === controller) sourceRef.current = null;
      }
    })();
  }, [appendLog, closeSource, refreshAgentRuns]);

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
          setRun((prev) => ({
            ...prev,
            status: "complete",
            activePhase: "complete",
            completedAt: new Date().toISOString(),
            finalCards,
            batchFeedback,
          }));
          appendLog(
            makeLogEntry(
              "complete",
              finalCards.length > 0 ? "Pipeline complete" : "No new cards",
              finalCards.length > 0
                ? `${finalCards.length} card(s) ready`
                : (batchFeedback ?? "Agent declined to generate this run"),
            ),
          );
        } catch (err) {
          appendLog(
            makeLogEntry(
              "error",
              "Failed to load cards",
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      })();
    }

    if (match.status === "failed" && settledRunIdRef.current !== match.id) {
      settledRunIdRef.current = match.id;
      const errMsg = match.lastError ?? "Pipeline failed";
      setRun((prev) => ({
        ...prev,
        status: "error",
        error: errMsg,
        completedAt: new Date().toISOString(),
      }));
      appendLog(makeLogEntry("error", "Pipeline failed", errMsg));
    }
  }, [runs, run.runId, run.status, appendLog]);

  // ── F5 recovery ─────────────────────────────────────────────────────
  // If sessionStorage thinks a run is active but the server has no
  // matching active run, settle back to idle / complete. Runs in `runs`
  // are server-truth — but they're polled, not live, so we mustn't fire
  // on the gap between /generate returning a runId and refreshAgentRuns
  // bringing it into the feed. A short grace window covers both real F5
  // recovery (feed stays empty across reload + first poll) and the
  // dispatch race (feed catches up within ~50–200ms typical, longer on
  // bad networks). Effect cleanup cancels the timer the moment the run
  // appears in the feed.
  useEffect(() => {
    if (run.status !== "running") return;
    if (!run.runId) return;
    if (runs.some((r) => r.id === run.runId)) return; // server has it
    const id = window.setTimeout(() => {
      setRun((prev) =>
        prev.finalCards.length > 0
          ? { ...prev, status: "complete", activePhase: "complete" }
          : { ...prev, status: "idle", activePhase: null, error: null },
      );
    }, 5_000);
    return () => window.clearTimeout(id);
  }, [runs, run.status, run.runId]);

  // ── Adopt orphan generator runs ─────────────────────────────────────
  // Across F5 the local sessionStorage may be empty / stale, but the
  // server may already have a generator run in flight (e.g. user clicked
  // Generate before refreshing, or another tab kicked one off). Without
  // this effect the local state stays "idle" and the Generate button
  // would re-enable, letting the user spawn a duplicate (which the
  // backend dedupes — but we shouldn't put the user in that confusing
  // race-the-button position in the first place).
  useEffect(() => {
    // Already tracking a run? leave it to the other effects.
    if (run.runId) return;
    if (run.status === "running" || run.status === "connecting") return;
    const orphan = runs.find(
      (r) =>
        r.kind === "generator.manual" &&
        (r.status === "queued" || r.status === "running"),
    );
    if (!orphan) return;
    setRun((prev) => ({
      ...prev,
      runId: orphan.id,
      status: "running",
      activePhase: "generating",
      startedAt: orphan.startedAt ?? prev.startedAt ?? new Date().toISOString(),
      logEntries: [
        makeLogEntry(
          "system",
          "Resumed",
          `Following existing generator run ${orphan.id}`,
        ),
        ...prev.logEntries,
      ].slice(0, 80),
    }));
  }, [runs, run.runId, run.status]);

  // `isRunning` reflects server truth, not just local state. The
  // Generate button (and PhaseTimer / chip text) consults this — so
  // after F5 the button stays disabled if a generator run is still
  // mid-flight on the server. Without this, the FE'd briefly show
  // Generate as enabled until the orphan-adoption effect fires next
  // poll, and an over-eager second click would race the dedup.
  const hasServerActiveGenerator = runs.some(
    (r) =>
      r.kind === "generator.manual" &&
      (r.status === "queued" || r.status === "running"),
  );
  const isRunning =
    run.status === "running" ||
    run.status === "connecting" ||
    hasServerActiveGenerator;

  return { run, generate, isRunning, closeSource };
}
