import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Supabase VITE_* fallback: lib/supabase.ts throws at import when these
  // are unset, which blanks the whole SPA. .env.local is gitignored, so a
  // fresh worktree has no local copy — backfill the two keys from
  // backend/.env (the decrypted output every worktree gets from
  // `make ensure-env`; internal-reward-dashboard reads the same source via
  // envDir). Explicit process env / .env.local still win; only VITE_-prefixed
  // vars ever reach the client bundle, so the master secrets in that file
  // stay server-side.
  const agentsEnv = loadEnv(mode, path.resolve(__dirname, "../backend"), "");
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
  // backend is the only backend after the apis + openclaw retirement.
  // /api/* in dev hits api:8000 directly via the proxy below.
  const pinApiTarget = env.VITE_PIN_API_PROXY_TARGET || "http://127.0.0.1:8000";
  const isCapacitor = !!(process.env.VITE_CAPACITOR || env.VITE_CAPACITOR);

  if (isCapacitor && mode === "production") {
    const missing: string[] = [];
    if (!String(env.VITE_SUPABASE_URL ?? "").trim())
      missing.push("VITE_SUPABASE_URL");
    if (!String(env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim()) {
      missing.push("VITE_SUPABASE_PUBLISHABLE_KEY");
    }
    if (!String(env.VITE_PIN_API_URL ?? "").trim())
      missing.push("VITE_PIN_API_URL");
    if (missing.length > 0) {
      throw new Error(
        `[Capacitor] 缺少环境变量: ${missing.join(", ")}。\n` +
          "请在 proactive-ai-frontend/ 下创建 .env.production.local（可参考 env.capacitor.example），填好后重新执行 npm run build:cap 或 npm run cap:ios。",
      );
    }
  }

  // Native-only Capacitor packages have no web runtime. On the
  // Capacitor build (`VITE_CAPACITOR=1`) they resolve to their real
  // implementations from node_modules + the local capacitor-plugins
  // workspace; on the web build they would either fail to resolve at
  // bundle time OR (when marked Rollup-external) leave bare specifiers
  // in the output that the browser rejects at runtime. We alias each
  // one to a single Proxy-based stub (`src/lib/native-plugin-stub.ts`)
  // so Rollup substitutes a real module and the bundle ships without
  // unresolvable specifiers. Call sites are already isNative-gated, so
  // the stub's "loud throw on invoke" branch never fires on web.
  const nativePluginAliases = isCapacitor
    ? {}
    : Object.fromEntries(
        [
          "@pin/capacitor-ambient-ai",
          "@capacitor-community/contacts",
          "@capacitor-community/sqlite",
          "@capacitor/geolocation",
          "@capacitor/push-notifications",
          "@capgo/capacitor-barometer",
          "@capgo/capacitor-health",
        ].map((pkg) => [
          pkg,
          path.resolve(__dirname, "src/lib/native-plugin-stub.ts"),
        ]),
      );

  return {
    plugins: [react()],
    // Single base path "/" everywhere. Frontend is served at the root
    // of its own host (apis-era /proactive/ subpath retired along with apis).
    base: "/",
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: {
        "@": path.resolve(__dirname, "src"),
        // 共用层包源码直引（无 build 步骤，HMR 直通），与 tsconfig paths 对应。
        // 架构见 research/2026-06-10-frontend-layering.mdx §3.2。
        "@pin-ai/core": path.resolve(__dirname, "../packages/core/src/index.ts"),
        "@pin-ai/state": path.resolve(__dirname, "../packages/state/src/index.ts"),
        "@pin-ai/ui-kit": path.resolve(__dirname, "../packages/ui-kit/src/index.ts"),
        "@pin-ai/ui-web": path.resolve(__dirname, "../packages/ui-web/src/index.ts"),
        // design token：ui-web primitive 值导入 typeScale/elevation（运行时真值），
        // 容器 node_modules 不含 workspace 包 → 必须 alias 到源码文件。
        // 指 tokens.mjs（ESM 视图）：Vite dev 不对源码 .cjs 合成命名导出会白屏，
        // ESM+JSON dev/prod 双通。（tailwind config 另走相对路径引 tokens.cjs。）
        "@pin-ai/design": path.resolve(__dirname, "../packages/design/tokens.mjs"),
        ...nativePluginAliases,
      },
    },
    server: {
      port: 3000,
      proxy: {
        // backend: every /api/* call. The legacy /api/proactive/*
        // entry was removed along with the apis service.
        "/api": {
          target: pinApiTarget,
          ws: true,
        },
      },
    },
    build: {
      // Single output dir for both web and capacitor. The web Dockerfile
      // copies dist/ into nginx; capacitor's `npx cap sync` reads dist/.
      outDir: path.resolve(__dirname, "dist"),
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(__dirname, "index.html"),
        // Native plugin handling moved to `resolve.alias` above so
        // Rollup substitutes the real packages with a JS stub rather
        // than leaving bare specifiers (which the browser cannot
        // resolve). Keep this slot for future bundle-shaping needs.
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      setupFiles: ["src/test-setup.ts"],
      // lib/supabase.ts throws at import if these are unset; the real VITE_*
      // are dotenvx-encrypted and not available to vitest. Inject harmless
      // dummies so any test that transitively imports it can load.
      env: {
        VITE_SUPABASE_URL: "http://localhost:54321",
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      },
    },
  };
});
