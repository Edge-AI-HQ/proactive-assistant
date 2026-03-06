import express, { type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";
import { prepareContainerRuntime } from "./domain/container/index.js";
import { syncContainerStates } from "./domain/container/syncContainerStates.js";
import { config, validateConfig } from "./domain/common/config.js";
import { cleanupExpiredGatewaySessions } from "./domain/common/db/index.js";
import { ensureInfraRuntimeConfigured } from "./domain/common/infraRuntime.js";
import { db as paymentDb } from "./domain/payment/db.js";
import { validatePaymentPriceConsistencyOnStartup } from "./domain/payment/startupValidation.js";
import { applySubscriptionPeriodBudgetsWithLock } from "./domain/payment/subscriptionSync.js";
import {
  registerHttpRoutes,
  registerRawBodyRoutes,
  registerWsRoutes,
} from "./controller/api_route_handler.js";
import { buildBot } from "./domain/telegram-bot/bot.js";
import { registerTelegramRouterRoutes } from "./domain/telegram-router/routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const missing = validateConfig();
if (missing.length) {
  console.warn(`Missing env vars: ${missing.join(", ")}`);
}

ensureInfraRuntimeConfigured();

await prepareContainerRuntime();
await validatePaymentPriceConsistencyOnStartup();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

const miniappDevProxy = httpProxy.createProxyServer({
  target: "http://127.0.0.1:3002",
  changeOrigin: true,
  ws: false,
});

miniappDevProxy.on("error", (error, _req, res) => {
  console.error("Miniapp dev proxy error", error);
  if ("writeHead" in res) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("Miniapp dev server is unavailable.");
  }
});

registerRawBodyRoutes(app);
registerTelegramRouterRoutes(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (config.nodeEnv !== "production") {
  app.use("/tg-subscription-mini", (req, res) => {
    miniappDevProxy.web(req, res);
  });
}

// Serve static files from public directory
const publicPath = path.join(process.cwd(), "public");
console.log("Serving static files from:", publicPath);
app.use(express.static(publicPath));

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

const server = app.listen(config.port, () => {
  console.log(`PINClaw backend listening on :${config.port}`);
});

registerWsRoutes(server);

// Start Telegram bot with webhook mode
if (config.telegram.token) {
  const bot = buildBot();
  const webhookPath = "/webhook/telegram";
  const expectedWebhookUrl =
    config.telegramRouter.webhookUrl || `${config.publicBaseUrl}${webhookPath}`;

  // Initialize bot before storing globally
  bot
    .init()
    .then(() => {
      console.log(`Telegram bot initialized: @${bot.botInfo.username}`);
      (global as any).__telegramBot = bot;

      const routerWebhookUrl = config.telegramRouter.webhookUrl;
      console.log(`Setting webhook to: ${expectedWebhookUrl}${routerWebhookUrl ? ' (via router)' : ' (direct)'}`);

      // Set webhook
      const webhookOptions: any = {
        drop_pending_updates: true,
      };
      if (config.telegram.webhookSecret) {
        webhookOptions.secret_token = config.telegram.webhookSecret;
        console.log("Webhook secret token will be configured");
      }

      return bot.api.setWebhook(expectedWebhookUrl, webhookOptions);
    })
    .then((result) => {
      console.log("Telegram webhook set successfully:", result);

      // Verify webhook was set correctly
      return bot.api.getWebhookInfo();
    })
    .then((info) => {
      console.log("Webhook verification:", {
        url: info.url,
        pending_update_count: info.pending_update_count,
        has_custom_certificate: info.has_custom_certificate,
      });

      if (info.url !== expectedWebhookUrl) {
        console.warn(
          `WARNING: Webhook URL mismatch! Expected ${expectedWebhookUrl}, got ${info.url}`,
        );
      }
    })
    .catch((error: unknown) => {
      console.error("Failed to initialize or set webhook:", error);
    });
} else {
  console.warn("TELEGRAM_BOT_TOKEN not configured, bot will not start");
}
