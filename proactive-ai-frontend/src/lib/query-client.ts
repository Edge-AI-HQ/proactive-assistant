import { QueryClient, defaultShouldDehydrateQuery } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import { cardsKeys, userSettingsKeys } from "@pin-ai/state";

/**
 * Web 端的 QueryClient（composition root 持有，main.tsx 提供 Provider）。
 * @pin-ai/state 的域 hooks 只消费 context，不持有 client —— 三端各自建。
 *
 * 默认策略定调（对照迁移前手写 hooks 的行为）：
 * - retry: 1 —— 手写版不重试；一次温和重试当传输层兜底，UI 错误语义不变。
 * - staleTime 默认 0、refetchOnWindowFocus 默认开 —— 即时陈旧 + 回到前台
 *   刷新，与「打开面板即重拉」的旧行为一致且更及时。
 * - gcTime 24h 与 persister 的 maxAge 对齐（TQ persist 官方配法）：被持久化
 *   的 query 不能先于持久层被 gc。数据量受白名单约束（KB 级），内存无虞。
 * - 轮询节奏由各域 hook 自带（refetchInterval），不在这里全局设。
 */
const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, gcTime: PERSIST_MAX_AGE_MS },
  },
});

/**
 * Sync-A：TQ persister 白名单持久化（research/2026-06-11-local-sync-engine.mdx）。
 *
 * 打开 app 先渲染上次的 settings/cards（0 网络），后台 refetch 更新——
 * 解决「白屏等 /settings 12s 重试」。**白名单是红线**：只持久化小体量
 * server-state（settings、cards 列表）；conversation 消息体一律禁入——
 * Claude Desktop 把全量会话塞进单个持久化 blob 导致 5MB/s 写放大的事故
 * 是本设计的反面教材（调研见同步引擎文档 §2.2）。消息体的本地化由
 * Sync-B 的 SQLite delta 同步承担，不走 persister。
 *
 * per-user 隔离：persister key 用 `pinai:` 前缀——useAuth.signOut 已有的
 * localStorage 前缀清扫 + full reload 顺带覆盖（换号不继承缓存，零新代码）。
 * buster 版本号在持久形状不兼容时整体作废缓存。
 */
const PERSIST_ALLOWLIST_ROOTS: ReadonlySet<unknown> = new Set([
  userSettingsKeys.all[0],
  cardsKeys.all[0],
]);

export function isPersistableQueryKey(queryKey: readonly unknown[]): boolean {
  return PERSIST_ALLOWLIST_ROOTS.has(queryKey[0]);
}

function storageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // SSR / 隐私模式拿不到 storage → 不持久化，纯内存运行
  }
}

export const persistOptions: Omit<PersistQueryClientOptions, "queryClient"> = {
  persister: createSyncStoragePersister({
    storage: storageOrNull(),
    key: "pinai:rq-cache",
  }),
  maxAge: PERSIST_MAX_AGE_MS,
  buster: "v1",
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      defaultShouldDehydrateQuery(query) && isPersistableQueryKey(query.queryKey),
  },
};
