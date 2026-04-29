import express, { type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareContainerRuntime } from "./domain/container/index.js";
import { config, validateConfig } from "./domain/common/config.js";
import {
  initializeRequestLogging,
  requestLogContextMiddleware,
} from "./domain/common/requestLogContext.js";
import { db as paymentDb } from "./domain/payment/db.js";
import { applySubscriptionPeriodBudgetsWithLock } from "./domain/payment/subscriptionSync.js";
import {
  registerHttpRoutes,
  registerRawBodyRoutes,
  registerWsRoutes,
} from "./controller/api_route_handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
void __dirname;

const missing = validateConfig();
if (missing.length) {
  console.warn(`Missing env vars: ${missing.join(", ")}`);
}

initializeRequestLogging();

await prepareContainerRuntime();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(requestLogContextMiddleware);

registerRawBodyRoutes(app);

app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use(cookieParser());

// Serve static files from public directory
const publicPath = path.join(process.cwd(), "public");
console.log("Serving static files from:", publicPath);
app.use(express.static(publicPath, {
  maxAge: "7d",
  setHeaders(res, filePath) {
    // HTML must never be cached — it references hashed JS/CSS bundles
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));

registerHttpRoutes(app);

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "pinclaw-api-gateway",
    time: new Date().toISOString(),
    runtime: config.container.runtime,
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.send("PINClaw backend API is running.");
});

setInterval(
  () => {
    void paymentDb.cleanupExpiredPaymentSessions().catch((error: unknown) => {
      console.error("Failed to cleanup payment sessions", error);
    });
    void applySubscriptionPeriodBudgetsWithLock().catch((error: unknown) => {
      console.error("Failed to apply subscription period budgets", error);
    });
  },
  5 * 60 * 1000,
);

const server = app.listen(config.port, () => {
  console.log(`PINClaw backend listening on :${config.port}`);
});

registerWsRoutes(server);
