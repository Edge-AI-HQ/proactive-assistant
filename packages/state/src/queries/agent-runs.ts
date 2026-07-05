import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  fetchActiveAgentRuns,
  hasInflightAgentRuns,
  type ActiveAgentRun,
  type AgentRunKind,
} from "@pin-ai/core";

export const agentRunsKeys = {
  active: ["agent-runs", "active"] as const,
};

export interface UseActiveAgentRunsState {
  runs: ActiveAgentRun[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_ACTIVE_MS = 4_000;
const POLL_IDLE_MS = 30_000;

/**
 * Polls /api/agent-runs/active to surface in-flight agent runs to the UI.
 *
 * Single source of truth — chip UIs (DebugPanel reconnect chip,
 * AutoEvolutionSettings notice, NowFeed generator banner, AgentRunIndicator)
 * all subscribe here instead of holding their own task state. F5 →
 * re-fetch from server → state restored.
 *
 * Cadence（自适应 refetchInterval）:
 *   - Active runs in progress → poll every 4s (matches backend tick + a
 *     small grace window).
 *   - All idle → fall back to 30s so we still catch e.g. the daily
 *     dream firing without thrashing the API.
 *
 * 错误时保留上一次的 runs（TQ 天然行为：error 不清 data），下个 tick 自愈。
 */
export function useActiveAgentRuns(): UseActiveAgentRunsState {
  const query = useQuery({
    queryKey: agentRunsKeys.active,
    queryFn: ({ signal }) => fetchActiveAgentRuns(signal),
    refetchInterval: (q) =>
      hasInflightAgentRuns(q.state.data ?? []) ? POLL_ACTIVE_MS : POLL_IDLE_MS,
  });

  const refresh = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    runs: query.data ?? [],
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : String(query.error)
      : null,
    refresh,
  };
}

/**
 * Detect "this kind just transitioned to succeeded" and call cb once
 * per run id. Common pattern: NowFeed wants to refetch /api/cards when
 * a generator run finishes; MemoriesPanel wants to refetch when dream
 * or evolve finishes; etc.
 *
 * Pass an array of kinds so a single panel can react to multiple agent
 * types (e.g. memory invalidates on dream OR evolve).
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
