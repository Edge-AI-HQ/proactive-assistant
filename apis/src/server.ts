import express, { type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareContainerRuntime } from "./domain/container/index.js";
import { config, validateConfig } from "./domain/common/config.js";
import { cleanupExpiredGatewaySessions } from "./domain/common/db/index.js";
import { ensureInfraRuntimeConfigured } from "./domain/common/infraRuntime.js";
import { db as paymentDb } from "./domain/payment/db.js";
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files from public directory
const publicPath = path.join(process.cwd(), "public");
console.log("Serving static files from:", publicPath);
app.use(express.static(publicPath));

registerHttpRoutes(app);

// Telegram webhook endpoint (before other routes)
const webhookPath = '/webhook/telegram';
app.post(webhookPath, express.json(), (req: Request, res: Response) => {
  // This will be initialized after server starts
  const bot = (global as any).__telegramBot;
  if (!bot) {
    res.sendStatus(503);
    return;
  }
  bot.handleUpdate(req.body)
    .then(() => res.sendStatus(200))
    .catch((error: unknown) => {
      console.error('Telegram webhook error:', error);
      res.sendStatus(500);
    });
});

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
  },
  5 * 60 * 1000,
);

const server = app.listen(config.port, () => {
  console.log(`PIN AI unified backend listening on :${config.port}`);
});

registerWsRoutes(server);

// Start Telegram bot with webhook mode
if (config.telegram.token) {
  const bot = buildBot();
  
  // Initialize bot before storing globally
  bot.init()
    .then(() => {
      (global as any).__telegramBot = bot;
      
      const webhookUrl = `${config.publicBaseUrl}${webhookPath}`;
      
      // Set webhook
      const webhookOptions: any = {
        drop_pending_updates: true,
      };
      if (config.telegram.webhookSecret) {
        webhookOptions.secret_token = config.telegram.webhookSecret;
      }
      
      return bot.api.setWebhook(webhookUrl, webhookOptions);
    })
    .then(() => {
      console.log(`Telegram bot webhook set to: ${config.publicBaseUrl}${webhookPath}`);
    })
    .catch((error: unknown) => {
      console.error('Failed to initialize or set webhook:', error);
    });
} else {
  console.warn('TELEGRAM_BOT_TOKEN not configured, bot will not start');
}
