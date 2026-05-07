/**
 * Polls /api/agent-runs/active to surface in-flight agent runs to the UI.
 *
 * Single source of truth — chip UIs (DebugPanel reconnect chip,
 * AutoDreamingSettings notice, NowFeed generator banner, future
 * AgentRunIndicator) all subscribe here instead of holding their own
 * task state. F5 → re-fetch from server → state restored.
 *
 * Cadence:
 *   - Active runs in progress → poll every 4s (matches backend tick + a
 *     small grace window; the NOTIFY-driven dispatcher claims tasks
 *     within ~50ms, so we don't need to poll faster than that).
 *   - All idle → fall back to 30s so we still catch e.g. the daily
 *     dream firing without thrashing the API.
 *
 * The hook also exposes refresh() so action triggers (Run Dreaming,
 * Reconnect, Generate) can immediately yank a fresh state instead of
 * waiting for the next poll tick.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { proxyFetch } from "@/lib/api";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AgentRunKind =
  | "auto.dreaming"
  | "connector.init"
  | "connector.evolve"
  | "crystallize"
  | "generator"
  | "user.prompt"
  | string;

export interface ActiveAgentRun {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  trigger: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  progress: Record<string, unknown>;
  payload: Record<string, unknown>;
}

interface UseActiveAgentRunsState {
  runs: ActiveAgentRun[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_ACTIVE_MS = 4_000;
const POLL_IDLE_MS = 30_000;

const TERMINAL: ReadonlySet<AgentRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

function hasInflight(runs: ActiveAgentRun[]): boolean {
  return runs.some((r) => !TERMINAL.has(r.status));
}

export function useActiveAgentRuns(): UseActiveAgentRunsState {
  const [runs, setRuns] = useState<ActiveAgentRun[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Refs avoid re-running the polling effect on every state change. The
  // effect spins up once on mount and tunes its own cadence based on
  // the latest runs snapshot.
  const runsRef = useRef<ActiveAgentRun[]>(runs);
  runsRef.current = runs;

  const fetchOnce = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const res = await proxyFetch("/agent-runs/active", { signal });
      if (!res.ok) {
        // Don't blow away cached runs on transient error — keep showing
        // last-known state and let the next tick recover.
        const detail = await res.text();
        setError(`HTTP ${res.status}: ${detail.slice(0, 120)}`);
        return;
      }
      const data = (await res.json()) as { ok?: boolean; runs?: ActiveAgentRun[] };
      setRuns(Array.isArray(data.runs) ? data.runs : []);
      setError(null);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      await fetchOnce(controller.signal);
      if (cancelled) return;
      const interval = hasInflight(runsRef.current) ? POLL_ACTIVE_MS : POLL_IDLE_MS;
      timer = setTimeout(tick, interval);
    };

    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnce]);

  return { runs, loading, error, refresh };
}

/**
 * Detect "this kind just transitioned to succeeded" and call cb once
 * per run id. Common pattern: NowFeed wants to refetch /api/cards when
 * a generator run finishes; MemoriesPanel wants to refetch when dream
 * or evolve finishes; etc.
 *
 * Pass an array of kinds so a single panel can react to multiple agent
 * types (e.g. memory invalidates on dream OR evolve OR crystallize).
 */
export function useAgentRunSuccess(
  runs: ActiveAgentRun[],
  kinds: readonly AgentRunKind[],
  onSuccess: (run: ActiveAgentRun) => void,
): void {
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const r of runs) {
      if (r.status !== "succeeded") continue;
      if (!kinds.includes(r.kind)) continue;
      if (seenRef.current.has(r.id)) continue;
      seenRef.current.add(r.id);
      onSuccess(r);
    }
    // Cap memory: forget runs that have aged out of the active window
    // so the set doesn't grow unbounded across long sessions.
    const stillVisible = new Set(runs.map((r) => r.id));
    seenRef.current = new Set(
      [...seenRef.current].filter((id) => stillVisible.has(id)),
    );
  }, [runs, kinds, onSuccess]);
}
