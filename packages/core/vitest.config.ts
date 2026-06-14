import { defineConfig } from "vitest/config";

// @pin-ai/core 是纯 TS 层，测试跑在默认 node 环境。这里只固定 TZ=UTC：
// ambient timeline 的 morning_health cutoff 走 Date.getHours()（本地小时），
// 不钉时区的话同一条 "15:00Z" fixture 在 UTC 读作下午、在开发者本地 TZ 读作
// 上午，测试会本地红、CI 绿。与 proactive-ai-frontend 的 test-setup 对齐
// （下沉的 pipeline.test.ts 原本就在 TZ=UTC 下写）。
export default defineConfig({
  test: {
    env: {
      TZ: "UTC",
    },
  },
});
