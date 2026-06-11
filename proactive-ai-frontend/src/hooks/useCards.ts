/**
 * Phase 2 薄壳 —— TQ 核心已迁 @pin-ai/state（queries/cards.ts）；本文件只剩
 * web 平台的 sessionStorage 预填（F5 后 cards 区不闪空）：读缓存作 initialData
 * 注入、数据更新后回写。平台存储不进 state 包；本地同步引擎落地后由 TQ
 * persister 统一接管（research/2026-06-11-local-sync-engine.mdx Sync-A），
 * 届时删除本壳。
 *
 * 纯函数与类型（parseEntries / outcome helpers / VisibleCardEntry）已提纯进
 * @pin-ai/core 的 domain/cards，此处 re-export 兼容旧 import 路径。
 */
import { useEffect, useMemo } from "react";
import { useCardsQuery } from "@pin-ai/state";
import { parseEntries, type VisibleCardEntry } from "@pin-ai/core";

export {
  isCompletedCardOutcome,
  isHiddenCardOutcome,
  parseEntries,
  type CardOutcome,
  type CardScore,
  type VisibleCardEntry,
} from "@pin-ai/core";

// v2: 缓存体从 raw /cards payload 改为 parsed VisibleCardEntry[]（解析一次，
// 读侧免重复 parse）。v1 旧条目 parse 不出（形状不符）自然失效重拉，无害。
export const CARDS_CACHE_PREFIX = "pinai.cards.v2";

export interface UseCardsState {
  loading: boolean;
  cards: VisibleCardEntry[];
  error: string | null;
}

export function cardsCacheKey(limit: number, cacheScope: string): string {
  return `${CARDS_CACHE_PREFIX}.${encodeURIComponent(cacheScope)}.limit.${limit}`;
}

function sessionStorageOrNull(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readCachedCards(limit: number, cacheScope: string): VisibleCardEntry[] | null {
  const storage = sessionStorageOrNull();
  if (!storage) return null;
  try {
    const raw = storage.getItem(cardsCacheKey(limit, cacheScope));
    if (!raw) return null;
    // 复用 parseEntries 做形状校验（容忍手工篡改/版本漂移的缓存）。
    const cards = parseEntries({ cards: JSON.parse(raw) });
    return cards.length > 0 ? cards : null;
  } catch {
    return null;
  }
}

export function writeCardsCache(limit: number, cacheScope: string, cards: VisibleCardEntry[]): void {
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    storage.setItem(cardsCacheKey(limit, cacheScope), JSON.stringify(cards));
  } catch {
    // Cache writes are best-effort; the live /cards response remains source of truth.
  }
}

export function useCards(opts?: { limit?: number; cacheScope?: string | null }): UseCardsState & {
  refresh: () => Promise<void>;
} {
  const limit = opts?.limit ?? 200;
  const cacheScope = opts?.cacheScope ?? null;

  const initialData = useMemo(
    () => (cacheScope ? readCachedCards(limit, cacheScope) ?? undefined : undefined),
    [cacheScope, limit],
  );

  const query = useCardsQuery({ limit, initialData });

  useEffect(() => {
    if (!cacheScope || query.cards.length === 0) return;
    writeCardsCache(limit, cacheScope, query.cards);
  }, [cacheScope, limit, query.cards]);

  return query;
}
