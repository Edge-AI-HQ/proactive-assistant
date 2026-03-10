import {
  Router,
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import httpProxy from "http-proxy";
import {
  createGatewaySession,
  getAssistantById,
  getGatewaySession,
  getUserByTelegramId,
  readAssistantRuntimeMetadata,
  setAssistantRuntimeMetadataKey,
} from "../domain/common/db/index.js";
import { domainErrorMessage, isDomainError } from "../domain/common/errors.js";
import { requireApiAuth } from "../domain/common/httpAuth.js";
import { repairAssistantContainerById } from "../domain/container/usecases.js";
import {
  createAssistantWithoutContainerByInput,
  listAssistantsByOwnerId,
} from "../domain/claw-assistant/usecases.js";
import { ensureGatewayAssistantReady } from "../domain/gateway/assistant_warmup.js";
import {
  renderGatewayBootstrapPageHtml,
  resolveGatewayWsUrl,
} from "../domain/gateway/pages.js";
import {
  cancelStripeSubscription,
  createCheckoutSession,
  createInternalPaymentSession,
  listActivePlansForApi,
  readInternalSubscription,
} from "../domain/payment/checkout.js";
import { readPaymentPublicBaseUrl } from "../domain/payment/publicBaseUrl.js";
import {
  buildOpenclawAuthHeaders,
  resolveAssistantGatewayTarget,
  rewriteGatewayProxyRequestUrl,
} from "../domain/gateway/proxy_orchestrator.js";
import { gatewayHostHeaders } from "../domain/container/contracts.js";
import {
  getCurrentModel,
  setCurrentModel,
} from "../domain/gateway/gateway_rpc.js";
import { createGatewaySessionByBody } from "../domain/gateway/session_api.js";
import {
  buildSkillViewList,
  installSkillToConfig,
  readSkillsConfigFromRuntimeMetadata,
  SKILLS_METADATA_KEY,
  uninstallSkillFromConfig,
} from "../domain/skills/openclaw_skills.js";
import {
  readCookieFromIncoming,
  requireGatewaySession,
  resolveGatewayAssistantForUser,
} from "../domain/gateway/session_guard.js";
import { hasActiveSubscriptionForService } from "../domain/payment/subscriptionGuard.js";
import { isSubscriptionActiveForService } from "../domain/payment/subscriptionPolicy.js";
import { config } from "../domain/common/config.js";
import { setLogContextTelegramIdentity } from "../domain/common/requestLogContext.js";
import { ensureTelegramUser } from "../domain/user/service.js";
import { resetTelegramUserAccount } from "../domain/user/usecases.js";
import type { AssistantRecord } from "../types.js";
import {
  buildGoogleAuthStartUrl,
  disconnectGoogleOAuth,
  getGoogleConnectionStatus,
  handleGoogleOAuthCallback,
} from "../domain/google-oauth/service.js";
import { buildMiniGoogleReturnUrl } from "../domain/google-oauth/miniapp.js";

const miniAppEntryPath = path.join(
  process.cwd(),
  "public",
  "mini",
  "index.html",
);
const miniSessionCookieName = "mini_sid";
const miniSessionTtlHours = 12;
const miniAuthMaxAgeSeconds = 24 * 60 * 60;
const miniAuthFutureSkewSeconds = 5 * 60;

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
let proxyErrorHandlerBound = false;

const rejectUpgrade = (socket: Socket, statusLine: string): void => {
  socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
  socket.destroy();
};

const ensureAssistantReadyForDashboard = async (
  assistant: AssistantRecord,
): Promise<AssistantRecord | null> => {
  if (assistant.container_status === "running") return assistant;
  return ensureGatewayAssistantReady(assistant);
};

const ensureProxyErrorHandlerBound = (): void => {
  if (proxyErrorHandlerBound) return;

  proxy.on(
    "error",
    (err: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
      void req;
      console.error("Dashboard proxy error", err);

      if ("writableEnded" in res && !res.writableEnded) {
        if ("statusCode" in res) {
          res.statusCode = 502;
        }
        res.end("Assistant gateway unavailable");
      }
    },
  );

  proxyErrorHandlerBound = true;
};

const parseTelegramInitData = (
  rawInitData: string,
): { ok: true; telegramUserId: number; telegramUsername: string | null } | { ok: false; error: string } => {
  const normalized = rawInitData.trim();
  if (!normalized) {
    return { ok: false, error: "init_data is required" };
  }
  if (!config.telegram.token.trim()) {
    return { ok: false, error: "Telegram bot token is not configured" };
  }

  const params = new URLSearchParams(normalized);
  const hash = params.get("hash")?.trim().toLowerCase();
  const authDateRaw = params.get("auth_date")?.trim() ?? "";
  const userRaw = params.get("user");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    return { ok: false, error: "Invalid Telegram initData hash" };
  }
  if (!/^\d+$/.test(authDateRaw)) {
    return { ok: false, error: "Invalid Telegram initData auth_date" };
  }
  if (!userRaw) {
    return { ok: false, error: "Missing Telegram user payload" };
  }

  const authDate = Number.parseInt(authDateRaw, 10);
  const now = Math.floor(Date.now() / 1000);
  if (
    now - authDate > miniAuthMaxAgeSeconds ||
    authDate - now > miniAuthFutureSkewSeconds
  ) {
    return { ok: false, error: "Telegram initData is expired" };
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(config.telegram.token)
    .digest();
  const expectedHash = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");
  const expectedHashBuffer = Buffer.from(expectedHash, "hex");
  const actualHashBuffer = Buffer.from(hash, "hex");
  if (expectedHashBuffer.length !== actualHashBuffer.length) {
    return { ok: false, error: "Telegram initData verification failed" };
  }
  if (!crypto.timingSafeEqual(actualHashBuffer, expectedHashBuffer)) {
    return { ok: false, error: "Telegram initData verification failed" };
  }

  let parsedUser: { id?: unknown; username?: unknown };
  try {
    parsedUser = JSON.parse(userRaw) as { id?: unknown; username?: unknown };
  } catch {
    return { ok: false, error: "Invalid Telegram user payload" };
  }

  const userIdValue = parsedUser.id;
  const telegramUserId =
    typeof userIdValue === "number"
      ? userIdValue
      : Number.parseInt(String(userIdValue ?? ""), 10);
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) {
    return { ok: false, error: "Invalid Telegram user id" };
  }
  const telegramUsername =
    typeof parsedUser.username === "string" && parsedUser.username.trim()
      ? parsedUser.username.trim()
      : null;

  return { ok: true, telegramUserId, telegramUsername };
};

const setMiniSessionCookie = (
  res: Response,
  sessionToken: string,
  expiresAt: string,
): void => {
  res.cookie(miniSessionCookieName, sessionToken, {
    httpOnly: true,
    sameSite: "none", // Required for Telegram WebApp (iframe/cross-site context)
    secure: true, // Required when sameSite=none
    path: "/",
    expires: new Date(expiresAt),
  });
};

const clearMiniSessionCookie = (res: Response): void => {
  res.clearCookie(miniSessionCookieName, { path: "/" });
};

const normalizeBotUsername = (): string | null => {
  const raw = String(config.telegram.botUsername || "").trim();
  if (!raw) return null;
  return raw.replace(/^@+/, "") || null;
};

const renderMiniGoogleDonePage = (
  status: "connected" | "error" | "disconnected",
  reason?: string,
): string => {
  const botUsername = normalizeBotUsername();
  const openTelegramUrl = botUsername
    ? `https://t.me/${botUsername}?startapp=manage`
    : "tg://resolve";

  const title =
    status === "connected"
      ? "Google connected"
      : status === "disconnected"
        ? "Google disconnected"
        : "Google connection failed";
  const description =
    status === "connected"
      ? "Authorization completed. Return to Telegram Mini App and continue in chat."
      : status === "disconnected"
        ? "Google has been disconnected. Return to Telegram Mini App."
        : `Authorization failed${reason ? `: ${reason}` : ""}. Please retry from Telegram Mini App.`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b1220; color: #e6edf7; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: 100%; max-width: 520px; background: #121a2b; border: 1px solid #26324a; border-radius: 16px; padding: 24px; }
    h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.2; }
    p { margin: 0 0 16px; color: #b6c2d9; line-height: 1.5; }
    a.btn { display: inline-block; text-decoration: none; background: #4f8cff; color: white; padding: 12px 16px; border-radius: 10px; font-weight: 600; }
    .hint { margin-top: 14px; font-size: 13px; color: #8fa0c0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${title}</h1>
      <p>${description}</p>
      <a class="btn" href="${openTelegramUrl}">Back to Telegram</a>
      <p class="hint">After returning, send your previous request again in chat.</p>
    </div>
  </div>
</body>
</html>`;
};

const requireMiniSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const sessionToken =
    typeof req.cookies?.[miniSessionCookieName] === "string"
      ? (req.cookies[miniSessionCookieName] as string)
      : "";
  if (!sessionToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const session = await getGatewaySession(sessionToken);
  if (!session) {
    clearMiniSessionCookie(res);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = await getUserByTelegramId(session.telegram_user_id);
  if (!user) {
    clearMiniSessionCookie(res);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  setLogContextTelegramIdentity(user.telegram_user_id, user.telegram_username);
  req.gatewayUser = user;
  next();
};

/**
 * Quick payload — only the data needed to render the main UI immediately.
 * Skips skills, google, and plans (deferred to a separate request).
 */
const buildQuickStatePayload = async (
  telegramUserId: number,
  telegramUsername: string | null,
) => {
  const [assistants, subscriptionResult] = await Promise.all([
    listAssistantsByOwnerId(telegramUserId),
    readInternalSubscription(String(telegramUserId)),
  ]);

  const assistant = assistants[0] ?? null;
  const subscription = subscriptionResult.subscription;
  const active = isSubscriptionActiveForService(subscription);

  return {
    user: {
      telegram_user_id: telegramUserId,
      telegram_username: telegramUsername,
    },
    assistant: assistant
      ? {
          exists: true,
          id: assistant.id,
          username: assistant.assistant_bot_username ?? null,
          status: assistant.container_status ?? "unknown",
        }
      : {
          exists: false,
        },
    subscription: subscription
      ? {
          active,
          status: subscription.status,
          plan_id: subscription.plan_id,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_end: subscription.current_period_end,
        }
      : {
          active,
          status: null,
          plan_id: null,
          cancel_at_period_end: false,
          current_period_end: null,
        },
    plans: null as null,
    skills: null as null,
    google: null as null,
  };
};

/**
 * Deferred payload — heavier data loaded after initial render.
 */
const buildDeferredStatePayload = async (
  telegramUserId: number,
) => {
  const assistants = await listAssistantsByOwnerId(telegramUserId);
  const assistant = assistants[0] ?? null;

  const [plansResult, googleStatus, runtimeMetadata] = await Promise.all([
    listActivePlansForApi(),
    getGoogleConnectionStatus(telegramUserId),
    assistant ? readAssistantRuntimeMetadata(assistant.id) : Promise.resolve({}),
  ]);

  const skillsConfig = readSkillsConfigFromRuntimeMetadata(runtimeMetadata);
  const skillViews = buildSkillViewList(skillsConfig);

  return {
    plans: plansResult.plans,
    skills: {
      supported: Boolean(assistant),
      message: assistant
        ? "Install/uninstall updates OpenClaw skills config and refreshes runtime."
        : "Create assistant first to manage skills.",
      items: skillViews,
      config: skillsConfig,
    },
    google: googleStatus,
  };
};

export const createDashboardApiRouter = (): Router => {
  const router = Router();

  router.post(
    "/session",
    requireApiAuth,
    async (req: Request, res: Response) => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const session = await createGatewaySessionByBody(body);
        res.status(200).json(session);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  return router;
};

export const registerDashboardApiRoutes = (app: Application): void => {
  app.use("/api/gateway", createDashboardApiRouter());
};

export const createDashboardRouter = (): Router => {
  const router = Router();

  const requireDashboardSession = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    void requireGatewaySession(
      req as Request<{ user_id: string }>,
      res,
      next,
    ).catch((error: unknown) => {
      console.error("Dashboard session check failed", error);
      res.status(500).send("Dashboard session check failed.");
    });
  };

  router.get("/mini", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(miniAppEntryPath);
  });

  router.get(
    "/mini/google/start",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).send("Mini session check failed.");
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).send("Gateway user missing.");
        return;
      }

      try {
        const url = await buildGoogleAuthStartUrl(
          user.telegram_user_id,
          buildMiniGoogleReturnUrl("/mini/google/done", { status: "connected" }),
        );
        res.redirect(url);
      } catch (error: unknown) {
        console.error("Mini google start failed", error);
        res.redirect(
          buildMiniGoogleReturnUrl("/mini/google/done", {
            status: "error",
            error: "oauth_start_failed",
          }),
        );
      }
    },
  );

  router.get("/mini/google/callback", async (req: Request, res: Response) => {
    try {
      const result = await handleGoogleOAuthCallback({
        code: typeof req.query.code === "string" ? req.query.code : undefined,
        state: typeof req.query.state === "string" ? req.query.state : undefined,
        error: typeof req.query.error === "string" ? req.query.error : undefined,
      });
      const nextPath =
        result.nextPath ||
        buildMiniGoogleReturnUrl("/mini/google/done", { status: "connected" });
      res.redirect(nextPath);
    } catch (error: unknown) {
      console.error("Mini google callback failed", error);
      res.redirect(
        buildMiniGoogleReturnUrl("/mini/google/done", {
          status: "error",
          error: "oauth_callback_failed",
        }),
      );
    }
  });

  router.get("/mini/google/done", (req: Request, res: Response) => {
    const statusParam = String(req.query.google || "connected").trim().toLowerCase();
    const status =
      statusParam === "error"
        ? "error"
        : statusParam === "disconnected"
          ? "disconnected"
          : "connected";
    const reason =
      typeof req.query.reason === "string"
        ? req.query.reason
        : typeof req.query.error === "string"
          ? req.query.error
          : undefined;
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderMiniGoogleDonePage(status, reason));
  });

  router.post(
    "/api/mini/bootstrap",
    async (req: Request, res: Response) => {
      const initDataRaw =
        typeof req.body?.init_data === "string" ? req.body.init_data : "";
      const verification = parseTelegramInitData(initDataRaw);
      if (!verification.ok) {
        res.status(401).json({ error: verification.error });
        return;
      }

      try {
        const user = await ensureTelegramUser(
          verification.telegramUserId,
          verification.telegramUsername,
        );
        setLogContextTelegramIdentity(
          user.telegram_user_id,
          user.telegram_username,
        );
        console.info("[auth:resolved]", {
          source: "mini_bootstrap",
          telegram_user_id: user.telegram_user_id,
          telegram_username: user.telegram_username,
        });
        const { sessionToken, expiresAt } = await createGatewaySession(
          user.telegram_user_id,
          miniSessionTtlHours,
        );
        setMiniSessionCookie(res, sessionToken, expiresAt);
        const payload = await buildQuickStatePayload(
          user.telegram_user_id,
          user.telegram_username,
        );
        res.status(200).json(payload);
      } catch (error: unknown) {
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.get(
    "/api/mini/state",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        const payload = await buildQuickStatePayload(
          user.telegram_user_id,
          user.telegram_username,
        );
        res.status(200).json(payload);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.get(
    "/api/mini/state/deferred",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        const payload = await buildDeferredStatePayload(
          user.telegram_user_id,
        );
        res.status(200).json(payload);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/google/start-url",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        const url = await buildGoogleAuthStartUrl(
          user.telegram_user_id,
          buildMiniGoogleReturnUrl("/mini/google/done", { status: "connected" }),
        );
        res.status(200).json({ url });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/google/disconnect",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        await disconnectGoogleOAuth(user.telegram_user_id);
        res.status(200).json({
          ok: true,
          message: "Google disconnected",
          redirect: buildMiniGoogleReturnUrl("/mini", {
            status: "disconnected",
          }),
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/create-assistant",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        const existing = await listAssistantsByOwnerId(user.telegram_user_id);
        if (existing.length > 0) {
          res.status(200).json({ created: false, assistant: existing[0] });
          return;
        }

        const result = await createAssistantWithoutContainerByInput({
          ownerTelegramUserId: user.telegram_user_id,
          ownerTelegramUsername: user.telegram_username,
          assistantBotId: null,
          assistantBotToken: null,
          assistantBotUsername: null,
        });

        res.status(200).json({ created: true, assistant: result.assistant });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          if (error.status === 409) {
            const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
            if (assistants.length > 0) {
              res.status(200).json({ created: false, assistant: assistants[0] });
              return;
            }
          }
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/repair-runtime",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const assistant = assistants[0];
        if (!assistant) {
          res.status(400).json({ error: "Assistant not found. Create assistant first." });
          return;
        }

        const result = await repairAssistantContainerById(assistant.id);
        res.status(200).json({
          ok: true,
          deleted: result.deleted,
          container_id: result.containerId,
          ready: result.ready,
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/checkout",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (
      req: Request<Record<string, never>, unknown, { plan?: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        const plan =
          typeof req.body?.plan === "string"
            ? req.body.plan.trim().toLowerCase()
            : "";
        if (!plan) {
          res.status(400).json({ error: "plan is required" });
          return;
        }

        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const paymentSession = await createInternalPaymentSession(req, {
          telegram_user_id: String(user.telegram_user_id),
          telegram_username: user.telegram_username ?? undefined,
          assistant_id: assistants[0]?.id,
          plan_code: plan,
        });
        const baseUrl = readPaymentPublicBaseUrl(req);
        const checkout = await createCheckoutSession(req, {
          token: paymentSession.token,
          plan,
          successUrl: `${baseUrl}/mini`,
        });

        res.status(200).json(checkout);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/skills/install",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (
      req: Request<Record<string, never>, unknown, { skill_key?: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      const skillKey =
        typeof req.body?.skill_key === "string" ? req.body.skill_key.trim() : "";
      if (!skillKey) {
        res.status(400).json({ error: "skill_key is required" });
        return;
      }

      try {
        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const assistant = assistants[0];
        if (!assistant) {
          res.status(400).json({ error: "Assistant not found. Create assistant first." });
          return;
        }

        const runtimeMetadata = await readAssistantRuntimeMetadata(assistant.id);
        const currentConfig = readSkillsConfigFromRuntimeMetadata(runtimeMetadata);
        const nextConfig = installSkillToConfig(currentConfig, skillKey);
        await setAssistantRuntimeMetadataKey(
          assistant.id,
          SKILLS_METADATA_KEY,
          nextConfig,
        );

        const hasActiveSubscription = await hasActiveSubscriptionForService(
          String(user.telegram_user_id),
        );
        if (hasActiveSubscription) {
          try {
            await ensureGatewayAssistantReady(assistant);
          } catch (error: unknown) {
            console.warn("Skills install saved but runtime refresh failed", {
              assistantId: assistant.id,
              skillKey,
              error: error instanceof Error ? error.message : String(error || ""),
            });
          }
        }

        res.status(200).json({
          ok: true,
          skill_key: skillKey,
          skills: buildSkillViewList(nextConfig),
          config: nextConfig,
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/skills/uninstall",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (
      req: Request<Record<string, never>, unknown, { skill_key?: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      const skillKey =
        typeof req.body?.skill_key === "string" ? req.body.skill_key.trim() : "";
      if (!skillKey) {
        res.status(400).json({ error: "skill_key is required" });
        return;
      }

      try {
        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const assistant = assistants[0];
        if (!assistant) {
          res.status(400).json({ error: "Assistant not found. Create assistant first." });
          return;
        }

        const runtimeMetadata = await readAssistantRuntimeMetadata(assistant.id);
        const currentConfig = readSkillsConfigFromRuntimeMetadata(runtimeMetadata);
        const nextConfig = uninstallSkillFromConfig(currentConfig, skillKey);
        await setAssistantRuntimeMetadataKey(
          assistant.id,
          SKILLS_METADATA_KEY,
          nextConfig,
        );

        const hasActiveSubscription = await hasActiveSubscriptionForService(
          String(user.telegram_user_id),
        );
        if (hasActiveSubscription) {
          try {
            await ensureGatewayAssistantReady(assistant);
          } catch (error: unknown) {
            console.warn("Skills uninstall saved but runtime refresh failed", {
              assistantId: assistant.id,
              skillKey,
              error: error instanceof Error ? error.message : String(error || ""),
            });
          }
        }

        res.status(200).json({
          ok: true,
          skill_key: skillKey,
          skills: buildSkillViewList(nextConfig),
          config: nextConfig,
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  // -----------------------------------------------------------------------
  // Model management
  // -----------------------------------------------------------------------

  router.get(
    "/api/mini/models",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (_req: Request, res: Response) => {
      const user = (_req as Request).gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const assistant = assistants[0];

        // Build available models from config
        const allowedModels = config.litellm.allowedModels.length
          ? config.litellm.allowedModels
          : [config.litellm.openclawDefaultModel];
        const defaultModel = config.litellm.openclawDefaultModel;

        // Try to read current model from running gateway
        let currentModel: string | null = null;
        if (assistant?.container_status === "running" && user.gateway_token?.trim()) {
          try {
            const target = resolveAssistantGatewayTarget(assistant);
            currentModel = await getCurrentModel(target, user.gateway_token.trim());
          } catch {
            // Gateway unreachable — fall back to default
          }
        }

        res.status(200).json({
          ok: true,
          current_model: currentModel ?? `litellm/${defaultModel}`,
          default_model: `litellm/${defaultModel}`,
          available_models: allowedModels.map((id) => ({
            id,
            ref: `litellm/${id}`,
          })),
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/change-model",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (
      req: Request<Record<string, never>, unknown, { model?: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      const modelRef =
        typeof req.body?.model === "string" ? req.body.model.trim() : "";
      if (!modelRef) {
        res.status(400).json({ error: "model is required (e.g. litellm/claude-opus-4-6)" });
        return;
      }

      // Validate against allowed models
      const bareId = modelRef.replace(/^litellm\//i, "");
      const allowedModels = config.litellm.allowedModels.length
        ? config.litellm.allowedModels
        : [config.litellm.openclawDefaultModel];
      if (!allowedModels.includes(bareId)) {
        res.status(400).json({
          error: `Model "${bareId}" is not in the allowed list.`,
          allowed: allowedModels,
        });
        return;
      }

      const normalizedRef = modelRef.startsWith("litellm/")
        ? modelRef
        : `litellm/${modelRef}`;

      try {
        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const assistant = assistants[0];
        if (!assistant) {
          res.status(400).json({ error: "Assistant not found. Create assistant first." });
          return;
        }

        const gatewayToken = user.gateway_token?.trim();
        if (!gatewayToken) {
          res.status(500).json({ error: "Gateway token missing." });
          return;
        }

        if (assistant.container_status !== "running") {
          res.status(503).json({
            error: "Assistant is not running. Please wait for it to start or repair it.",
          });
          return;
        }

        const target = resolveAssistantGatewayTarget(assistant);
        const result = await setCurrentModel(target, gatewayToken, normalizedRef);

        if (!result.ok) {
          res.status(502).json({
            error: `Gateway rejected model change: ${result.error}`,
          });
          return;
        }

        res.status(200).json({
          ok: true,
          model: normalizedRef,
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/cancel-subscription",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        const result = await cancelStripeSubscription(String(user.telegram_user_id));
        res.status(200).json(result);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/api/mini/reset-account",
    async (req: Request, res: Response, next: NextFunction) => {
      void requireMiniSession(req, res, next).catch((error: unknown) => {
        console.error("Mini session check failed", error);
        res.status(500).json({ error: "Mini session check failed." });
      });
    },
    async (req: Request, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }

      try {
        await resetTelegramUserAccount(user.telegram_user_id);
        res.clearCookie("mini_sid");
        res.status(200).json({ ok: true });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.get(
    "/gateway/:user_id/mini",
    requireDashboardSession,
    async (req: Request<{ user_id: string }>, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).send("Gateway user missing.");
        return;
      }

      // Ensure authenticated user can only access their own route.
      if (String(user.telegram_user_id) !== req.params.user_id) {
        res.status(403).send("Forbidden");
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      res.sendFile(miniAppEntryPath);
    },
  );

  router.get(
    "/gateway/:user_id/mini/state",
    requireDashboardSession,
    async (req: Request<{ user_id: string }>, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }
      if (String(user.telegram_user_id) !== req.params.user_id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      try {
        const [assistants, subscriptionResult, plansResult] = await Promise.all([
          listAssistantsByOwnerId(user.telegram_user_id),
          readInternalSubscription(String(user.telegram_user_id)),
          listActivePlansForApi(),
        ]);

        const assistant = assistants[0] ?? null;
        const subscription = subscriptionResult.subscription;
        const runtimeMetadata = assistant
          ? await readAssistantRuntimeMetadata(assistant.id)
          : {};
        const skillsConfig = readSkillsConfigFromRuntimeMetadata(runtimeMetadata);
        const skillViews = buildSkillViewList(skillsConfig);

        res.status(200).json({
          user: {
            telegram_user_id: user.telegram_user_id,
            telegram_username: user.telegram_username,
          },
          assistant: assistant
            ? {
                exists: true,
                id: assistant.id,
                username: assistant.assistant_bot_username ?? null,
                status: assistant.container_status ?? "unknown",
              }
            : {
                exists: false,
              },
          subscription: subscription
            ? {
                active: await hasActiveSubscriptionForService(
                  String(user.telegram_user_id),
                ),
                status: subscription.status,
                plan_id: subscription.plan_id,
                cancel_at_period_end: subscription.cancel_at_period_end,
                current_period_end: subscription.current_period_end,
              }
            : {
                active: false,
                status: null,
                plan_id: null,
                cancel_at_period_end: false,
                current_period_end: null,
              },
          plans: plansResult.plans,
          skills: {
            supported: Boolean(assistant),
            message: assistant
              ? "Install/uninstall will update OpenClaw skills config and trigger runtime refresh."
              : "Create assistant first to manage skills.",
            items: skillViews,
            config: skillsConfig,
          },
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/gateway/:user_id/mini/create-assistant",
    requireDashboardSession,
    async (req: Request<{ user_id: string }>, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }
      if (String(user.telegram_user_id) !== req.params.user_id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      try {
        const existing = await listAssistantsByOwnerId(user.telegram_user_id);
        if (existing.length > 0) {
          res.status(200).json({ created: false, assistant: existing[0] });
          return;
        }

        const result = await createAssistantWithoutContainerByInput({
          ownerTelegramUserId: user.telegram_user_id,
          ownerTelegramUsername: user.telegram_username,
          assistantBotId: null,
          assistantBotToken: null,
          assistantBotUsername: null,
        });

        res.status(200).json({ created: true, assistant: result.assistant });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          if (error.status === 409) {
            const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
            if (assistants.length > 0) {
              res.status(200).json({ created: false, assistant: assistants[0] });
              return;
            }
          }
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/gateway/:user_id/mini/repair-runtime",
    requireDashboardSession,
    async (req: Request<{ user_id: string }>, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }
      if (String(user.telegram_user_id) !== req.params.user_id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      try {
        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const assistant = assistants[0];
        if (!assistant) {
          res.status(400).json({ error: "Assistant not found. Create assistant first." });
          return;
        }

        const result = await repairAssistantContainerById(assistant.id);
        res.status(200).json({
          ok: true,
          deleted: result.deleted,
          container_id: result.containerId,
          ready: result.ready,
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/gateway/:user_id/mini/checkout",
    requireDashboardSession,
    async (
      req: Request<{ user_id: string }, unknown, { plan?: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }
      if (String(user.telegram_user_id) !== req.params.user_id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      try {
        const plan = typeof req.body?.plan === "string" ? req.body.plan.trim().toLowerCase() : "";
        if (!plan) {
          res.status(400).json({ error: "plan is required" });
          return;
        }

        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const paymentSession = await createInternalPaymentSession(req, {
          telegram_user_id: String(user.telegram_user_id),
          telegram_username: user.telegram_username ?? undefined,
          assistant_id: assistants[0]?.id,
          plan_code: plan,
        });
        const checkout = await createCheckoutSession(req, {
          token: paymentSession.token,
          plan,
        });

        res.status(200).json(checkout);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/gateway/:user_id/mini/skills/install",
    requireDashboardSession,
    async (
      req: Request<{ user_id: string }, unknown, { skill_key?: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }
      if (String(user.telegram_user_id) !== req.params.user_id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const skillKey =
        typeof req.body?.skill_key === "string" ? req.body.skill_key.trim() : "";
      if (!skillKey) {
        res.status(400).json({ error: "skill_key is required" });
        return;
      }

      try {
        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const assistant = assistants[0];
        if (!assistant) {
          res.status(400).json({ error: "Assistant not found. Create assistant first." });
          return;
        }

        const runtimeMetadata = await readAssistantRuntimeMetadata(assistant.id);
        const currentConfig = readSkillsConfigFromRuntimeMetadata(runtimeMetadata);
        const nextConfig = installSkillToConfig(currentConfig, skillKey);
        await setAssistantRuntimeMetadataKey(
          assistant.id,
          SKILLS_METADATA_KEY,
          nextConfig,
        );

        const hasActiveSubscription = await hasActiveSubscriptionForService(
          String(user.telegram_user_id),
        );
        if (hasActiveSubscription) {
          try {
            await ensureGatewayAssistantReady(assistant);
          } catch (error: unknown) {
            console.warn("Skills install saved but runtime refresh failed", {
              assistantId: assistant.id,
              skillKey,
              error: error instanceof Error ? error.message : String(error || ""),
            });
          }
        }

        res.status(200).json({
          ok: true,
          skill_key: skillKey,
          skills: buildSkillViewList(nextConfig),
          config: nextConfig,
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/gateway/:user_id/mini/skills/uninstall",
    requireDashboardSession,
    async (
      req: Request<{ user_id: string }, unknown, { skill_key?: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }
      if (String(user.telegram_user_id) !== req.params.user_id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const skillKey =
        typeof req.body?.skill_key === "string" ? req.body.skill_key.trim() : "";
      if (!skillKey) {
        res.status(400).json({ error: "skill_key is required" });
        return;
      }

      try {
        const assistants = await listAssistantsByOwnerId(user.telegram_user_id);
        const assistant = assistants[0];
        if (!assistant) {
          res.status(400).json({ error: "Assistant not found. Create assistant first." });
          return;
        }

        const runtimeMetadata = await readAssistantRuntimeMetadata(assistant.id);
        const currentConfig = readSkillsConfigFromRuntimeMetadata(runtimeMetadata);
        const nextConfig = uninstallSkillFromConfig(currentConfig, skillKey);
        await setAssistantRuntimeMetadataKey(
          assistant.id,
          SKILLS_METADATA_KEY,
          nextConfig,
        );

        const hasActiveSubscription = await hasActiveSubscriptionForService(
          String(user.telegram_user_id),
        );
        if (hasActiveSubscription) {
          try {
            await ensureGatewayAssistantReady(assistant);
          } catch (error: unknown) {
            console.warn("Skills uninstall saved but runtime refresh failed", {
              assistantId: assistant.id,
              skillKey,
              error: error instanceof Error ? error.message : String(error || ""),
            });
          }
        }

        res.status(200).json({
          ok: true,
          skill_key: skillKey,
          skills: buildSkillViewList(nextConfig),
          config: nextConfig,
        });
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.post(
    "/gateway/:user_id/mini/cancel-subscription",
    requireDashboardSession,
    async (req: Request<{ user_id: string }>, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).json({ error: "Gateway user missing." });
        return;
      }
      if (String(user.telegram_user_id) !== req.params.user_id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      try {
        const result = await cancelStripeSubscription(String(user.telegram_user_id));
        res.status(200).json(result);
      } catch (error: unknown) {
        if (isDomainError(error)) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(500).json({ error: domainErrorMessage(error) });
      }
    },
  );

  router.get(
    "/gateway/:user_id/bot/:assistant_id",
    requireDashboardSession,
    async (
      req: Request<{ user_id: string; assistant_id: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).send("Gateway user missing.");
        return;
      }

      const assistant = await resolveGatewayAssistantForUser(
        user.telegram_user_id,
        req.params.assistant_id,
      );
      if (!assistant) {
        res.status(404).send("Assistant not found.");
        return;
      }
      if (!user.gateway_token?.trim()) {
        res.status(500).send("Gateway token missing.");
        return;
      }

      const hasActive = await hasActiveSubscriptionForService(
        String(user.telegram_user_id),
      );
      if (!hasActive) {
        res
          .status(402)
          .send(
            "Subscription expired or inactive. Please renew your subscription to use the assistant.",
          );
        return;
      }

      let readyAssistant: AssistantRecord | null = assistant;
      try {
        readyAssistant = await ensureAssistantReadyForDashboard(assistant);
        if (!readyAssistant) {
          res
            .status(503)
            .send(
              "Assistant container is starting. Please retry in a few seconds.",
            );
          return;
        }
      } catch (error: unknown) {
        console.error("Assistant dashboard warmup failed", error);
        res.status(502).send("Assistant gateway unavailable");
        return;
      }

      const gatewayUrl = resolveGatewayWsUrl(
        req,
        user.telegram_user_id,
        readyAssistant.id,
      );
      const gatewayToken = user.gateway_token?.trim();
      if (!gatewayToken) {
        res.status(500).send("Gateway token missing.");
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(
        renderGatewayBootstrapPageHtml({
          userId: user.telegram_user_id,
          assistantId: readyAssistant.id,
          gatewayUrl,
          gatewayToken,
        }),
      );
    },
  );

  router.use(
    "/gateway/:user_id/bot/:assistant_id/proxy",
    requireDashboardSession,
    async (
      req: Request<{ user_id: string; assistant_id: string }>,
      res: Response,
    ) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).send("Gateway user missing.");
        return;
      }

      const assistant = await resolveGatewayAssistantForUser(
        user.telegram_user_id,
        req.params.assistant_id,
      );
      if (!assistant) {
        res.status(404).send("Assistant not found.");
        return;
      }

      const hasActiveProxy = await hasActiveSubscriptionForService(
        String(user.telegram_user_id),
      );
      if (!hasActiveProxy) {
        res
          .status(402)
          .send(
            "Subscription expired or inactive. Please renew your subscription to use the assistant.",
          );
        return;
      }

      let readyAssistant: AssistantRecord | null = assistant;
      try {
        readyAssistant = await ensureAssistantReadyForDashboard(assistant);
        if (!readyAssistant) {
          res
            .status(503)
            .send(
              "Assistant container is starting. Please retry in a few seconds.",
            );
          return;
        }
      } catch (error: unknown) {
        console.error("Assistant dashboard warmup failed", error);
        res.status(502).send("Assistant gateway unavailable");
        return;
      }

      rewriteGatewayProxyRequestUrl(req, {
        telegramUserId: user.telegram_user_id,
        assistantId: readyAssistant.id,
      });

      let target: ReturnType<typeof resolveAssistantGatewayTarget>;
      try {
        target = resolveAssistantGatewayTarget(readyAssistant);
      } catch (error: unknown) {
        console.error("Assistant dashboard target resolve error", error);
        res.status(502).send("Assistant gateway unavailable");
        return;
      }

      proxy.web(req, res, {
        target: target.httpBaseUrl,
        changeOrigin: true,
        headers: {
          ...buildOpenclawAuthHeaders(user.gateway_token),
          ...gatewayHostHeaders(target),
        },
      });
    },
  );

  ensureProxyErrorHandlerBound();
  return router;
};

export const registerDashboardRoutes = (app: Application): void => {
  app.use(createDashboardRouter());
};

export const registerDashboardWsRoutes = (server: Server): void => {
  ensureProxyErrorHandlerBound();

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/gateway\/(\d+)\/bot\/(\d+)\/ws$/);
    if (!match) return;

    void (async () => {
      const userIdRaw = match[1];
      const assistantIdRaw = match[2];
      if (!userIdRaw || !assistantIdRaw) {
        rejectUpgrade(socket, "400 Bad Request");
        return;
      }

      const userId = Number.parseInt(userIdRaw, 10);
      const assistantId = Number.parseInt(assistantIdRaw, 10);
      const user = await getUserByTelegramId(userId);
      const assistant = await getAssistantById(assistantId);
      const sessionToken = readCookieFromIncoming(req, "gateway_sid");

      if (
        !user ||
        !assistant ||
        assistant.owner_telegram_user_id !== user.telegram_user_id ||
        !sessionToken
      ) {
        rejectUpgrade(socket, "403 Forbidden");
        return;
      }

      const session = await getGatewaySession(sessionToken);
      if (!session || session.telegram_user_id !== user.telegram_user_id) {
        rejectUpgrade(socket, "403 Forbidden");
        return;
      }
      if (!user.gateway_token?.trim()) {
        rejectUpgrade(socket, "500 Internal Server Error");
        return;
      }

      const hasActiveWs = await hasActiveSubscriptionForService(
        String(user.telegram_user_id),
      );
      if (!hasActiveWs) {
        rejectUpgrade(socket, "402 Payment Required");
        return;
      }

      let readyAssistant: AssistantRecord | null = assistant;
      try {
        readyAssistant = await ensureAssistantReadyForDashboard(assistant);
        if (!readyAssistant) {
          rejectUpgrade(socket, "503 Service Unavailable");
          return;
        }
      } catch (error: unknown) {
        console.error("Assistant dashboard WS warmup failed", error);
        rejectUpgrade(socket, "502 Bad Gateway");
        return;
      }

      req.url = "/";
      let target: ReturnType<typeof resolveAssistantGatewayTarget>;
      try {
        target = resolveAssistantGatewayTarget(readyAssistant);
      } catch (error: unknown) {
        console.error("Assistant dashboard WS target resolve error", error);
        rejectUpgrade(socket, "502 Bad Gateway");
        return;
      }

      proxy.ws(req, socket, head, {
        target: target.wsBaseUrl,
        changeOrigin: false,
        headers: {
          ...buildOpenclawAuthHeaders(user.gateway_token),
          ...gatewayHostHeaders(target),
        },
      });
    })().catch((error: unknown) => {
      console.error("Assistant dashboard WS upgrade error", error);
      rejectUpgrade(socket, "500 Internal Server Error");
    });
  });
};
