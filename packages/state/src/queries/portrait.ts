/**
 * L2 portrait + L1 events 域 hook（迁移模式见 queries/memories.ts 头注释）。
 *
 * `/api/user-strings` 返回六段画像 markdown（Mirror 渲染 USER/MEMORY/GOALS）；
 * `/api/events` 返回 L1 事件时间线（Ambient / Mirror 渲染活动流）。都是只读
 * server state，纯 React + TanStack Query，三端（web/Electron/RN）同一接口。
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  fetchEvents,
  fetchPortrait,
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
