import { defineConfig } from "drizzle-kit";
import { resolveAppRoot, appPaths } from "./src/core/paths.js";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/core/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: appPaths.pinDb(resolveAppRoot()),
  },
});
