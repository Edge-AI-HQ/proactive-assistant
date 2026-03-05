import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/tg-subscription-mini/",
  build: {
    outDir: path.resolve(__dirname, "../apis/public/tg-subscription-mini"),
    emptyOutDir: true,
  },
});
