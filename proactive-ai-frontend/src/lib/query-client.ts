import { QueryClient } from "@tanstack/react-query";

/**
 * Web 端的 QueryClient（composition root 持有，main.tsx 提供 Provider）。
 * @pin-ai/state 的域 hooks 只消费 context，不持有 client —— 三端各自建。
 *
 * 默认策略定调（对照迁移前手写 hooks 的行为）：
 * - retry: 1 —— 手写版不重试；一次温和重试当传输层兜底，UI 错误语义不变。
 * - staleTime 默认 0、refetchOnWindowFocus 默认开 —— 即时陈旧 + 回到前台
 *   刷新，与「打开面板即重拉」的旧行为一致且更及时。
 * - 轮询节奏由各域 hook 自带（refetchInterval），不在这里全局设。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1 },
  },
});
