/**
 * Phase 2 shim（Sync-A 瘦身完成）—— TQ 核心在 @pin-ai/state 的
 * queries/cards.ts；纯函数与类型在 @pin-ai/core 的 domain/cards。
 *
 * 原 sessionStorage 预填薄壳已删：F5 秒开由 TQ persister 的白名单持久化
 * 接管（lib/query-client.ts，Sync-A），per-user 隔离走 signOut 的前缀清扫
 * + full reload。旧 import 路径零改动；分层 Phase 4 统一清理本壳。
 */
import { useCardsQuery, type UseCardsQueryResult } from "@pin-ai/state";

export {
  isCompletedCardOutcome,
  isHiddenCardOutcome,
  parseEntries,
  type CardOutcome,
  type CardScore,
  type VisibleCardEntry,
} from "@pin-ai/core";

export interface UseCardsState {
  loading: boolean;
  cards: UseCardsQueryResult["cards"];
  error: string | null;
}

export function useCards(opts?: { limit?: number }): UseCardsState & {
  refresh: () => Promise<void>;
} {
  return useCardsQuery({ limit: opts?.limit });
}
