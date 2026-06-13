import { QueryClient } from "@tanstack/react-query";

/**
 * apps/web 的 QueryClient（@pin-ai/state 的 hooks 只消费 context，client
 * 由各端入口创建）。M0 先用内存版；离线持久化（frontend 的
 * PersistQueryClientProvider 白名单方案）等有真实需求再加。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});
