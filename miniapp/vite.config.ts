import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/tg-subscription-mini/",
  server: {
    port: 3002,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/mini": "http://127.0.0.1:3001",
      "/gateway": "http://127.0.0.1:3001",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../apis/public/tg-subscription-mini"),
    emptyOutDir: true,
  },
});
