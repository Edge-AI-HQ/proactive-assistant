import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchCards, type VisibleCardEntry } from "@pin-ai/core";

export const cardsKeys = {
  all: ["cards"] as const,
  list: (limit: number) => [...cardsKeys.all, { limit }] as const,
};

export interface UseCardsQueryResult {
  loading: boolean;
  cards: VisibleCardEntry[];
  error: string | null;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_LIMIT = 200;

/**
 * Cross-run card history for ChatTimeline + NOW view（TQ 版核心）。
 *
 * Refresh strategy（与迁移前等价的 TQ 映射）:
 *   - On mount（staleTime 0）。
 *   - On tab visibility change → TQ focusManager 的 refetchOnWindowFocus。
 *   - 30s interval；hidden 时 TQ 默认不轮询（refetchIntervalInBackground=false）。
 *   - On explicit refresh()（callers wire this to "generate just finished"）。
 *
 * `initialData`：web 端的 sessionStorage 预填由 app 薄壳注入
 * （proactive-ai-frontend hooks/useCards.ts）——平台存储不进 state 包；
 * 本地同步引擎落地后由 TQ persister 统一接管（research/2026-06-11-local-sync-engine.mdx Sync-A）。
 * 行为差异：注入 initialData 时 loading 直接为 false（迁移前缓存命中时首拉
 * 期间 loading 仍为 true）——显示缓存数据时不出骨架屏，合理化。
 *
 * No internal dedup. Each consumer decides（ChatTimeline 全量行；NOW view
 * 按 intentKey dedup）。错误时保留上一次 cards（TQ 天然行为）。
 */
export function useCardsQuery(opts?: {
  limit?: number;
  initialData?: VisibleCardEntry[];
}): UseCardsQueryResult {
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const query = useQuery({
    queryKey: cardsKeys.list(limit),
    queryFn: ({ signal }) => fetchCards(limit, signal),
    initialData: opts?.initialData,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const refresh = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    loading: query.isLoading,
    cards: query.data ?? [],
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : String(query.error)
      : null,
    refresh,
  };
}
