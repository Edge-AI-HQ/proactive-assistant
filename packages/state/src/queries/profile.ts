/**
 * Profile 域 hook（迁移模式见 queries/memories.ts 头注释）。
 *
 * `/profile` 一次返回整张快照（profile + goals + 嵌入的 memories/signals/
 * interests）。Mirror 只消费 profile + goals；memory 列表走独立的分页 hook
 * （useProfileMemories），所以这里不暴露 snapshot.memories，避免两个真源打架。
 *
 * 纯 React + TanStack Query，三端（web/Electron/RN）同一接口。
 */
import { useCallback, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  fetchMemories,
  fetchProfileSnapshot,
  type Goal,
  type Memory,
  type ProfileSnapshot,
} from "@pin-ai/core";

/** Matches the legacy GoalsView page size so list/scroll behaviour is unchanged. */
const MEMORY_PAGE_SIZE = 5;

export const profileKeys = {
  all: ["profile"] as const,
  snapshot: () => [...profileKeys.all, "snapshot"] as const,
};

export interface UseProfileSnapshotResult {
  profile: ProfileSnapshot["profile"];
  /** Goals minus the closed ones, in fetch order — what the Mirror renders. */
  activeGoals: Goal[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useProfileSnapshot(enabled = true): UseProfileSnapshotResult {
  const query = useQuery({
    queryKey: profileKeys.snapshot(),
    queryFn: ({ signal }) => fetchProfileSnapshot(signal),
    enabled,
  });

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const goals = query.data?.goals ?? [];

  return {
    profile: query.data?.profile ?? null,
    activeGoals: goals.filter((goal) => goal.status !== "closed"),
    loading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch,
  };
}

export const profileMemoriesKeys = {
  all: ["profile-memories"] as const,
  list: () => [...profileMemoriesKeys.all] as const,
};

export interface UseProfileMemoriesResult {
  memories: Memory[];
  total: number;
  hasMore: boolean;
  /** First-page load (TQ isLoading): drives the initial skeleton. */
  loading: boolean;
  /** A "load more" page is in flight. */
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  refetch: () => Promise<void>;
}

/**
 * The Mirror's memory list — newest-first, offset-paginated with a "load more"
 * that accumulates pages (useInfiniteQuery). Distinct from `useMemories` (the
 * debug panel's single filterable page + mutations); this one is read-only and
 * accumulating, which is what the Mirror renders.
 */
export function useProfileMemories(enabled = true): UseProfileMemoriesResult {
  const query = useInfiniteQuery({
    queryKey: profileMemoriesKeys.list(),
    queryFn: ({ pageParam, signal }) =>
      fetchMemories(
        {
          status: "active",
          limit: MEMORY_PAGE_SIZE,
          offset: pageParam,
          orderBy: "created_at",
          orderDirection: "desc",
        },
        signal,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, page) => n + page.memories.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    enabled,
  });

  // Flatten + dedupe-by-id, memoized on the pages array so the reference stays
  // stable across unrelated re-renders (MemoryPanel's groupMemoriesByDay memo
  // keys off it). Dedupe guards the offset-pagination race: a memory inserted
  // at the head between page loads shifts the window, which would otherwise
  // repeat a row across two pages → duplicate React key + a doubled row.
  const pages = query.data?.pages;
  const memories = useMemo(() => {
    if (!pages) return [];
    const seen = new Set<string>();
    const out: Memory[] = [];
    for (const page of pages) {
      for (const memory of page.memories) {
        if (seen.has(memory.id)) continue;
        seen.add(memory.id);
        out.push(memory);
      }
    }
    return out;
  }, [pages]);
  const total = pages?.at(-1)?.total ?? memories.length;

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query]);

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    memories,
    total,
    hasMore: query.hasNextPage,
    loading: query.isLoading,
    loadingMore: query.isFetchingNextPage,
    error: query.error ? errorMessage(query.error) : null,
    loadMore,
    refetch,
  };
}
