/**
 * L2 portrait + L1 events 域 hook（迁移模式见 queries/memories.ts 头注释）。
 *
 * `/api/user-strings` 返回六段画像 markdown（Mirror 渲染 USER/MEMORY/GOALS）；
 * `/api/events` 返回 L1 事件时间线（Ambient / Mirror 渲染活动流）。都是只读
 * server state，纯 React + TanStack Query，三端（web/Electron/RN）同一接口。
 */
import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchEvents,
  fetchPortrait,
  streamEventsChanged,
  type EventItem,
  type EventsFilter,
  type Portrait,
} from "@pin-ai/core";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const portraitKeys = {
  all: ["portrait"] as const,
  slots: () => [...portraitKeys.all, "slots"] as const,
};

export interface UsePortraitResult {
  /** Per-slot markdown content (absent slots → ""). */
  slots: Record<string, string>;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function usePortrait(enabled = true): UsePortraitResult {
  const query = useQuery({
    queryKey: portraitKeys.slots(),
    queryFn: ({ signal }) => fetchPortrait(signal),
    enabled,
  });

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    slots: (query.data as Portrait | undefined)?.slots ?? {},
    loading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch,
  };
}

export const eventsKeys = {
  all: ["events"] as const,
  list: (filter: EventsFilter) => [...eventsKeys.all, filter] as const,
};

export interface UseEventsResult {
  events: EventItem[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Live refresh for the events timeline: subscribe the SSE signal plane
 * (`streamEventsChanged`) and invalidate every events query on each frame —
 * active `useEvents` hooks refetch over REST (signal plane / data plane
 * split). Reconnects with capped exponential backoff; a RE-connect starts by
 * invalidating once, because signals emitted while disconnected are gone (the
 * refetch closes the gap). The first connect doesn't — mounting `useEvents`
 * hooks just fetched. Callers keep a slow fallback poll as the safety net for
 * anything the signal plane misses (e.g. evolve's mark_curated, which doesn't
 * notify by design).
 */
export function useEventsLiveRefresh(enabled = true): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    let stopped = false;
    void (async () => {
      let attempt = 0;
      while (!stopped) {
        try {
          if (attempt > 0) {
            await queryClient.invalidateQueries({ queryKey: eventsKeys.all });
          }
          for await (const _signal of streamEventsChanged(ctl.signal)) {
            attempt = 0;
            await queryClient.invalidateQueries({ queryKey: eventsKeys.all });
          }
        } catch {
          // network / HTTP failure — fall through to the backoff retry
        }
        if (stopped) return;
        attempt += 1;
        const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    })();
    return () => {
      stopped = true;
      ctl.abort();
    };
  }, [enabled, queryClient]);
}

export function useEvents(
  filter: EventsFilter = {},
  enabled = true,
  pollMs?: number,
): UseEventsResult {
  const query = useQuery({
    queryKey: eventsKeys.list(filter),
    queryFn: ({ signal }) => fetchEvents(filter, signal),
    enabled,
    // Opt-in polling: the Events timeline passes ~10s for a near-live feel
    // (v1; v2 swaps to an SSE channel). Other callers omit it → no polling.
    refetchInterval: pollMs,
  });

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    events: query.data?.items ?? [],
    loading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch,
  };
}
