import express, { type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareContainerRuntime } from "./domain/container/index.js";
import { syncContainerStates } from "./domain/container/syncContainerStates.js";
import { config, validateConfig } from "./domain/common/config.js";
import { cleanupExpiredGatewaySessions } from "./domain/common/db/index.js";
import { ensureInfraRuntimeConfigured } from "./domain/common/infraRuntime.js";
import { db as paymentDb } from "./domain/payment/db.js";
import { applySubscriptionPeriodBudgets } from "./domain/payment/subscriptionSync.js";
import { validatePaymentPriceConsistencyOnStartup } from "./domain/payment/startupValidation.js";
import {
  registerHttpRoutes,
  registerRawBodyRoutes,
  registerWsRoutes,
} from "./controller/api_route_handler.js";
import { buildBot } from "./domain/telegram-bot/bot.js";

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

registerRawBodyRoutes(app);

// Telegram webhook endpoint (MUST be before express.json() middleware)
const webhookPath = "/webhook/telegram";
app.post(webhookPath, express.json(), (req: Request, res: Response) => {
  // Verify webhook secret if configured
  if (config.telegram.webhookSecret) {
    const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];
    if (receivedSecret !== config.telegram.webhookSecret) {
      console.error("Webhook secret mismatch!", {
        expected: config.telegram.webhookSecret.substring(0, 10) + "...",
        received: receivedSecret,
      });
      res.sendStatus(403);
      return;
    }
  }

  // This will be initialized after server starts
  const bot = (global as any).__telegramBot;
  if (!bot) {
    console.error("Bot not initialized yet");
    res.sendStatus(503);
    return;
  }

  bot
    .handleUpdate(req.body)
    .then(() => {
      res.sendStatus(200);
    })
    .catch((error: unknown) => {
      console.error("Telegram webhook error:", error);
      res.sendStatus(500);
    });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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
    void applySubscriptionPeriodBudgets().catch((error: unknown) => {
      console.error("Failed to apply subscription period budgets", error);
    });
    void syncContainerStates().catch((error: unknown) => {
      console.error("Failed to sync container states", error);
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

  // Initialize bot before storing globally
  bot
    .init()
    .then(() => {
      console.log(`Telegram bot initialized: @${bot.botInfo.username}`);
      (global as any).__telegramBot = bot;

      const routerWebhookUrl = config.telegramRouter.webhookUrl;
      const webhookUrl = routerWebhookUrl || `${config.publicBaseUrl}${webhookPath}`;
      console.log(`Setting webhook to: ${webhookUrl}${routerWebhookUrl ? ' (via router)' : ' (direct)'}`);

      // Set webhook
      const webhookOptions: any = {
        drop_pending_updates: true,
      };
      if (config.telegram.webhookSecret) {
        webhookOptions.secret_token = config.telegram.webhookSecret;
        console.log("Webhook secret token will be configured");
      }

      return bot.api.setWebhook(webhookUrl, webhookOptions);
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

      if (info.url !== `${config.publicBaseUrl}${webhookPath}`) {
        console.warn(
          `WARNING: Webhook URL mismatch! Expected ${config.publicBaseUrl}${webhookPath}, got ${info.url}`,
        );
      }
    })
    .catch((error: unknown) => {
      console.error("Failed to initialize or set webhook:", error);
    });
} else {
  console.warn("TELEGRAM_BOT_TOKEN not configured, bot will not start");
}
