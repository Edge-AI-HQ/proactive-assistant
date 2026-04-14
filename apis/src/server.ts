import express, { type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareContainerRuntime } from "./domain/container/index.js";
import { configureIdleSuspendMs, scanIdleAndCron, getIdleSuspendMs } from "./domain/container/idle_suspend.js";
import { syncContainerStates } from "./domain/container/syncContainerStates.js";
import { config, validateConfig } from "./domain/common/config.js";
import {
  initializeRequestLogging,
  requestLogContextMiddleware,
} from "./domain/common/requestLogContext.js";
import { cleanupExpiredGatewaySessions } from "./domain/common/db/index.js";
import { ensureInfraRuntimeConfigured } from "./domain/common/infraRuntime.js";
import { materializeGoogleOAuthClientSecretFromEnv } from "./domain/google-oauth/client_secret_file.js";
import { db as paymentDb } from "./domain/payment/db.js";
import { validatePaymentPriceConsistencyOnStartup } from "./domain/payment/startupValidation.js";
import { applySubscriptionPeriodBudgetsWithLock } from "./domain/payment/subscriptionSync.js";
import {
  registerHttpRoutes,
  registerRawBodyRoutes,
  registerWsRoutes,
} from "./controller/api_route_handler.js";
// Telegram bot and router imports removed — proactive-ai uses Supabase Auth.
// Legacy telegram-bot and telegram-router code remains in the codebase
// but is no longer wired into the server startup.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const missing = validateConfig();
if (missing.length) {
  console.warn(`Missing env vars: ${missing.join(", ")}`);
}

initializeRequestLogging();
ensureInfraRuntimeConfigured();
materializeGoogleOAuthClientSecretFromEnv();

await prepareContainerRuntime();
if (config.container.idleSuspendMs > 0) {
  configureIdleSuspendMs(config.container.idleSuspendMs);
  console.log(`[idle-suspend] Auto-suspend enabled: ${config.container.idleSuspendMs}ms idle timeout`);
}
try {
  await validatePaymentPriceConsistencyOnStartup();
} catch (err) {
  console.warn('[startup] Payment validation skipped (tables may not exist):', (err as Error).message);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(requestLogContextMiddleware);

registerRawBodyRoutes(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

app.get("/health", (req: Request, res: Response) => {
  void req;
  res.json({
    ok: true,
    service: "pinclaw-api-gateway",
    time: new Date().toISOString(),
    runtime: config.container.runtime,
  });
});

app.get("/", (req: Request, res: Response) => {
  void req;
  res.send("PINClaw backend API is running.");
});

setInterval(
  () => {
    void cleanupExpiredGatewaySessions().catch((error: unknown) => {
      console.error("Failed to cleanup gateway sessions", error);
    });
    void paymentDb.cleanupExpiredPaymentSessions().catch((error: unknown) => {
      console.error("Failed to cleanup payment sessions", error);
    });
    void syncContainerStates().catch((error: unknown) => {
      console.error("Failed to sync container states", error);
    });
    void applySubscriptionPeriodBudgetsWithLock().catch((error: unknown) => {
      console.error("Failed to apply subscription period budgets", error);
    });
  },
  5 * 60 * 1000,
);

// Combined idle-suspend + wake-on-cron scan.
// Fixed 30s interval ensures cron jobs are woken with ≥30s lead time (60s look-ahead window).
if (getIdleSuspendMs() > 0) {
  const scanIntervalMs = 30_000;
  setInterval(
    () => {
      void scanIdleAndCron().catch((error: unknown) => {
        console.error("Failed to run idle/cron scan", error);
      });
    },
    scanIntervalMs,
  );
  console.log(`[idle-suspend] Scan interval: ${scanIntervalMs}ms (idle + cron wake)`);
}

const server = app.listen(config.port, () => {
  console.log(`PINClaw backend listening on :${config.port}`);
});

registerWsRoutes(server);

// Telegram bot startup removed — proactive-ai cloud uses Supabase Auth + container proxy.
