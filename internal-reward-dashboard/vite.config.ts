import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, "../pinai-agents");
  const env = loadEnv(mode, envDir, "");
  const pinApiTarget = env.VITE_PIN_API_PROXY_TARGET || "http://127.0.0.1:8000";

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
