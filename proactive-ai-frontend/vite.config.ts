import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:3001";
  const isCapacitor = !!env.VITE_CAPACITOR;

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
