import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, "../backend");
  const env = loadEnv(mode, envDir, "");
  // /api/* splits across two backends now that reward-dashboard is its own
  // service: review routes (/api/reward-dashboard/*) → reward-dashboard (8002),
  // everything else (impersonate /api/operator/*, /api/agent-runs, /api/agent)
  // → api (8000). Set VITE_*_PROXY_TARGET to this worktree's live host ports
  // (`make urls`).
  const pinApiTarget = env.VITE_PIN_API_PROXY_TARGET || "http://127.0.0.1:8000";
  const rewardTarget = env.VITE_REWARD_PROXY_TARGET || "http://127.0.0.1:8002";

  return {
    plugins: [react()],
    envDir,
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    server: {
      port: 3004,
      proxy: {
        // More specific prefix first — vite matches in declaration order.
        "/api/reward-dashboard": {
          target: rewardTarget,
          changeOrigin: true,
        },
        "/api": {
          target: pinApiTarget,
          ws: true,
        },
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
    },
  };
});
