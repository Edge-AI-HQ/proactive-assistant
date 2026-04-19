import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:3001";
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
    base: isCapacitor ? "/" : "/proactive/",
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    server: {
      port: 3003,
      proxy: {
        "/api": {
          target: apiProxyTarget,
          ws: true,
        },
      },
    },
    build: {
      outDir: isCapacitor
        ? path.resolve(__dirname, "dist")
        : path.resolve(__dirname, "../apis/public/proactive"),
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(__dirname, "index.html"),
      },
    },
  };
});
