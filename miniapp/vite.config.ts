import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:3001";

  return {
    plugins: [react()],
    base: "/mini/",
    server: {
      port: 3002,
      proxy: {
        "/api": apiProxyTarget,
        "/mini": apiProxyTarget,
        "/gateway": apiProxyTarget,
      },
    },
    build: {
      outDir: path.resolve(__dirname, "../apis/public/mini"),
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(__dirname, "index.html"),
      },
    },
  };
});
