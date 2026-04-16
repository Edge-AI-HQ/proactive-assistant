import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/ui/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    /** CLI integration tests use `node:test`; run separately: `npm run test:cli` */
    exclude: [
      "node_modules/**",
      "src/cli/cli.test.ts",
      "src/cli/db/database.test.ts",
      "src/cli/db/sqlite_adapter.test.ts",
      "src/cli/domains/feedback/repository.test.ts",
      "src/cli/domains/ingest/service.test.ts",
      "src/cli/domains/loop/repository.test.ts",
      "src/cli/domains/personal/provider.test.ts",
      "src/cli/domains/profile/repository.test.ts",
      "src/cli/domains/world/repository.test.ts",
      "src/cli/domains/world/service.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/ui"),
      "@shared": path.resolve(__dirname, "./src/shared"),
    },
  },
});
