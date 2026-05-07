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
    if (!String(env.VITE_API_BASE_URL ?? "").trim())
      missing.push("VITE_API_BASE_URL");
    if (missing.length > 0) {
      throw new Error(
        `[Capacitor] 缺少环境变量: ${missing.join(", ")}。\n` +
          "请在 proactive-ai-frontend/ 下创建 .env.production.local（可参考 env.capacitor.example），填好后重新执行 npm run build:cap 或 npm run cap:ios。",
      );
    }
  }

  return {
    plugins: [react()],
    // Single base path "/" everywhere. Frontend is served at the root
    // of its own host (apis-era /proactive/ subpath retired along with apis).
    base: "/",
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
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
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
    },
  };
});
