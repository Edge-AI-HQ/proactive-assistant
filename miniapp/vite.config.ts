import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/mini/",
  server: {
    port: 3002,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/mini": "http://127.0.0.1:3001",
      "/gateway": "http://127.0.0.1:3001",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../apis/public/mini"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        demo: path.resolve(__dirname, "demo.html"),
      },
    },
  },
});
