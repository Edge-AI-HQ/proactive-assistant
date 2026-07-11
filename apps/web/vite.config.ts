import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Supabase VITE_* fallback：与 proactive-ai-frontend 同一套路——本地
  // worktree 没有 .env.local 时，从 backend/.env（make ensure-env 解密
  // 产物）回填两把公开 key。显式 process env / .env.local 优先；只有 VITE_
  // 前缀会进 client bundle，master secrets 不会泄漏。
  const agentsEnv = loadEnv(mode, path.resolve(__dirname, "../../backend"), "");
  for (const key of ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"]) {
    if (!String(env[key] ?? "").trim() && String(agentsEnv[key] ?? "").trim()) {
      process.env[key] = agentsEnv[key];
      env[key] = agentsEnv[key];
    }
  }
  if (mode === "development" && !String(env.VITE_SUPABASE_URL ?? "").trim()) {
    console.warn(
      "[vite] VITE_SUPABASE_URL 仍缺失(backend/.env 也没有)——先跑 `make ensure-env`,否则页面会白屏。",
    );
  }
  // 本地 dev：/api 直打本 worktree 的 api（host 端口随机，`make urls`
  // 查后通过 VITE_PIN_API_PROXY_TARGET 覆盖）。
  const pinApiTarget = env.VITE_PIN_API_PROXY_TARGET || "http://127.0.0.1:8000";

  return {
    plugins: [react()],
    base: "/",
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: {
        "@": path.resolve(__dirname, "src"),
        // 共用层包源码直引（无 build 步骤，HMR 直通），与 tsconfig paths 对应。
        // 容器内 /app(=本目录) + COPY packages/ → /packages，"../../packages"
        // 经 path.resolve 落到 /packages，同 proactive-ai-frontend 的机制。
        "@pin-ai/core": path.resolve(__dirname, "../../packages/core/src/index.ts"),
        "@pin-ai/state": path.resolve(__dirname, "../../packages/state/src/index.ts"),
        "@pin-ai/ui-kit": path.resolve(__dirname, "../../packages/ui-kit/src/index.ts"),
        // design token：src/ui-web primitive 值导入 typeScale/elevation（运行时真值），
        // 容器 node_modules 不含 workspace 包 → 必须 alias 到源码文件。
        // 指 tokens.mjs（ESM 视图）：Vite dev 不对源码 .cjs 合成命名导出会白屏，
        // ESM+JSON dev/prod 双通。（tailwind config 另走相对路径引 tokens.cjs。）
        "@pin-ai/design": path.resolve(__dirname, "../../packages/design/tokens.mjs"),
      },
    },
    server: {
      port: 3005,
      proxy: {
        "/api": {
          target: pinApiTarget,
          ws: true,
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, "dist"),
      emptyOutDir: true,
    },
    test: {
      environment: "jsdom",
      globals: true,
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      // 壳层 setup（matchMedia）+ src/ui-web 功能层 setup（i18n / storage /
      // ResizeObserver / lucide stub），对全部测试文件生效。
      setupFiles: ["src/test-setup.ts", "src/ui-web/test-setup.ts"],
      // src/ui-web 的 supabase.ts 在 import 期校验这两个 env；真值是 dotenvx
      // 加密的，测试注入无害假值即可加载。
      env: {
        VITE_SUPABASE_URL: "http://localhost:54321",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      },
    },
  };
});
