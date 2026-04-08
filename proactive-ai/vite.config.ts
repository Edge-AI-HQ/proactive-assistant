import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.PROACTIVE_AI_PROXY_TARGET;
  const gwToken = env.PROACTIVE_AI_GW_TOKEN;

  return {
    base: "./",
    server: {
      host: "::",
      port: 8080,
      hmr: { overlay: false },
      proxy: proxyTarget
        ? {
            "/proactive-ai": {
              target: proxyTarget,
              changeOrigin: true,
              headers: gwToken
                ? { Authorization: `Bearer ${gwToken}` }
                : undefined,
            },
          }
        : undefined,
    },
    plugins: [react(), viteSingleFile()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src/ui"),
        "@shared": path.resolve(__dirname, "./src/shared"),
      },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    build: {
      outDir: "dist/ui",
      emptyOutDir: true,
      cssCodeSplit: false,
      assetsInlineLimit: 100000000,
    },
  };
});
