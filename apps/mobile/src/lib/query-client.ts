/**
 * RN 端的 QueryClient（composition root 持有，App.tsx 提供 Provider）。
 * 默认策略对齐 dev `proactive-ai-frontend/src/lib/query-client.ts`：
 * - retry: 1 —— 一次温和重试当传输层兜底，UI 错误语义不变。
 * - staleTime 默认 0、refetchOnWindowFocus 默认开 —— RN 没有 window focus
 *   事件，由 setupAppFocusManager 把 AppState 喂给 focusManager（TanStack
 *   官方 RN 配方），回前台等价 web 的窗口聚焦刷新。
 * - gcTime 24h 与 persister 的 maxAge 对齐：被持久化的 query 不能先于
 *   持久层被 gc。数据量受白名单约束（KB 级），内存无虞。
 *
 * Sync-A persister（dev 的白名单持久化，冷启先渲染上次 settings/cards）：
 * persistOptions 由 App.tsx 的 PersistQueryClientProvider 消费。dev 的
 * sync localStorage persister 换 createAsyncStoragePersister（AsyncStorage，
 * TanStack 官方 RN 配方），其余选项逐字对齐 dev；persister key 沿用 dev 的
 * `pinai:rq-cache`（sign-out 的 AsyncStorage 前缀清扫已覆盖）。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
import { defaultShouldDehydrateQuery, focusManager, QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import { cardsKeys, userSettingsKeys } from "@pin-ai/state";

const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, gcTime: PERSIST_MAX_AGE_MS },
  },
});

/**
 * 白名单是红线（dev 同源逐字）：只持久化小体量 server-state（settings、
 * cards 列表）；conversation 消息体一律禁入——消息体的本地化由 SQLite
 * delta 同步承担，不走 persister。
 */
const PERSIST_ALLOWLIST_ROOTS: ReadonlySet<unknown> = new Set([
  userSettingsKeys.all[0],
  cardsKeys.all[0],
]);

export function isPersistableQueryKey(queryKey: readonly unknown[]): boolean {
  return PERSIST_ALLOWLIST_ROOTS.has(queryKey[0]);
}

/**
 * dev `proactive-ai-frontend/src/lib/query-client.ts` persistOptions 的 RN 版：
 * 除 persister 介质（localStorage→AsyncStorage）外逐字——maxAge 与 gcTime
 * 对齐，buster 在持久形状不兼容时整体作废缓存。
 */
export const persistOptions: Omit<PersistQueryClientOptions, "queryClient"> = {
  persister: createAsyncStoragePersister({
    storage: AsyncStorage,
    key: "pinai:rq-cache",
  }),
  maxAge: PERSIST_MAX_AGE_MS,
  buster: "v1",
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      defaultShouldDehydrateQuery(query) && isPersistableQueryKey(query.queryKey),
  },
};

let focusManagerBound = false;

/**
 * AppState → focusManager（TanStack 官方 RN 配方）：active 视为 focused，
 * 回前台触发 refetchOnWindowFocus 语义。幂等（重复调用只挂一个监听），
 * app 生命周期常驻不解绑。
 */
export function setupAppFocusManager(): void {
  if (focusManagerBound) return;
  focusManagerBound = true;
  AppState.addEventListener("change", (status) => {
    if (Platform.OS !== "web") {
      focusManager.setFocused(status === "active");
    }
  });
}
