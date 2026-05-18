import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // pinai-agents is the only backend after the apis + openclaw retirement.
  // /api/* in dev hits pinai-web:8000 directly via the proxy below.
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
        ...nativePluginAliases,
      },
    },
    server: {
      port: 3000,
      proxy: {
        // pinai-agents: every /api/* call. The legacy /api/proactive/*
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
      setupFiles: ["src/testSetup.ts"],
    },
  };
});
