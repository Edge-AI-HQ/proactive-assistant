import { defineConfig } from "vitest/config";

// ui-web 是 web 介质共享层，测试默认 jsdom（与 proactive-ai-frontend 的
// vitest 环境对齐——下沉的测试原本就在那套环境下写）。setup 提供
// storage / ResizeObserver / lucide stub，env 提供 supabase 假值
// （auth/supabase.ts import 期校验）。
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    env: {
      VITE_SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    },
  },
});
