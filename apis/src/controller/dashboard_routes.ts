import {
  Router,
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import httpProxy from "http-proxy";
import {
  getAssistantById,
  getGatewaySession,
  getUserByTelegramId,
  readAssistantRuntimeMetadata,
  setAssistantRuntimeMetadataKey,
} from "../domain/common/db/index.js";
import { domainErrorMessage, isDomainError } from "../domain/common/errors.js";
import { requireApiAuth } from "../domain/common/httpAuth.js";
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
import {
  buildOpenclawAuthHeaders,
  resolveAssistantGatewayTarget,
  rewriteGatewayProxyRequestUrl,
} from "../domain/gateway/proxy_orchestrator.js";
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
import type { AssistantRecord } from "../types.js";

const miniAppEntryPath = path.join(
  process.cwd(),
  "public",
  "tg-subscription-mini",
  "index.html",
);

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
                active: hasActiveSubscriptionForService(String(user.telegram_user_id)),
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
        headers: buildOpenclawAuthHeaders(user.gateway_token),
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
        headers: buildOpenclawAuthHeaders(user.gateway_token),
      });
    })().catch((error: unknown) => {
      console.error("Assistant dashboard WS upgrade error", error);
      rejectUpgrade(socket, "500 Internal Server Error");
    });
  });
};
