import express, {
  type Application,
  Router,
  type Request,
  type Response,
} from "express";
import { isDomainError } from "../domain/common/errors.js";
import {
  assertSubscribeTokenUsable,
  cancelStripeSubscription,
  createCheckoutSession,
  createInternalPaymentSession,
  listActivePlansForApi,
  readInternalSubscription,
  validateInternalPaymentSession,
} from "../domain/payment/checkout.js";
import { runCreditsMaintenance } from "../domain/payment/maintenance.js";
import { applySubscriptionPeriodBudgetsWithLock } from "../domain/payment/subscriptionSync.js";
import { buildCaptainReport } from "../domain/payment/captain_report.js";
import {
  renderCancelPage,
  renderSubscribePage,
  renderSuccessPage,
} from "../domain/payment/pages.js";
import { verifyInternalApiKey } from "../domain/payment/internalAuth.js";
import {
  parseLimit,
  requireStripe,
  requireStripeWebhookSecret,
} from "../domain/payment/stripeClient.js";
import {
  constructStripeEvent,
  processStripeEvent,
} from "../domain/payment/webhook.js";

const respondKnownError = (res: Response, error: unknown): boolean => {
  if (!isDomainError(error)) return false;
  res.status(error.status).json({ error: error.message });
  return true;
};

const readCronToken = (req: Request): string => {
  const authHeader =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization.trim()
      : "";
  return authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
};

const isCronAuthorized = (req: Request): boolean => {
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  const cronToken = readCronToken(req);
  return Boolean(cronSecret && cronToken && cronToken === cronSecret);
};

const ensureInternalOrCronAuth = (req: Request, res: Response): boolean => {
  const apiAuth = verifyInternalApiKey(req);
  const cronAuth = isCronAuthorized(req);
  if (!apiAuth.ok && !cronAuth) {
    res.status(401).json({ error: apiAuth.reason });
    return false;
  }
  return true;
};

export const createPaymentRouter = (): Router => {
  const router = Router();

  router.get("/health", (req: Request, res: Response) => {
    void req;
    res.status(200).json({
      status: "ok",
      service: "unified-payment",
      timestamp: new Date().toISOString(),
      env_check: {
        stripe_key: process.env.STRIPE_SECRET_KEY ? "set" : "missing",
        supabase_db_url: process.env.SUPABASE_DB_URL ? "set" : "missing",
        api_internal_token: process.env.API_INTERNAL_TOKEN ? "set" : "missing",
        payment_public_base_url: process.env.PAYMENT_PUBLIC_BASE_URL
          ? "set"
          : "optional",
      },
    });
  });

  router.get("/plans", async (req: Request, res: Response) => {
    void req;
    try {
      const response = await listActivePlansForApi();
      res.status(200).json(response);
    } catch (error: unknown) {
      if (respondKnownError(res, error)) return;
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  router.post(
    "/internal/payment-session",
    async (req: Request, res: Response) => {
      const auth = verifyInternalApiKey(req);
      if (!auth.ok) {
        res.status(401).json({ error: auth.reason });
        return;
      }

      try {
        const body = req.body as Record<string, unknown> | undefined;
        const response = await createInternalPaymentSession(req, body);
        res.status(200).json(response);
      } catch (error: unknown) {
        if (respondKnownError(res, error)) return;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        res.status(500).json({ error: message });
      }
    },
  );

  router.get("/internal/subscription", async (req: Request, res: Response) => {
    const auth = verifyInternalApiKey(req);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason });
      return;
    }

    try {
      const response = await readInternalSubscription(
        req.query.telegram_user_id,
      );
      res.status(200).json(response);
    } catch (error: unknown) {
      if (respondKnownError(res, error)) return;
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  router.get(
    "/internal/payment-session-validate",
    async (req: Request, res: Response) => {
      const auth = verifyInternalApiKey(req);
      if (!auth.ok) {
        res.status(401).json({ error: auth.reason });
        return;
      }

      try {
        const response = await validateInternalPaymentSession(req.query.token);
        res.status(200).json(response);
      } catch (error: unknown) {
        if (respondKnownError(res, error)) return;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    "/internal/credits-maintenance",
    async (req: Request, res: Response) => {
      if (!ensureInternalOrCronAuth(req, res)) return;

      try {
        const body = req.body as Record<string, unknown> | undefined;
        const limit = parseLimit(body?.limit);
        const response = await runCreditsMaintenance(limit);
        res.status(200).json(response);
      } catch (error: unknown) {
        if (respondKnownError(res, error)) return;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/internal/credits-maintenance",
    async (req: Request, res: Response) => {
      if (!ensureInternalOrCronAuth(req, res)) return;

      try {
        const limit = parseLimit(req.query.limit);
        const response = await runCreditsMaintenance(limit);
        res.status(200).json(response);
      } catch (error: unknown) {
        if (respondKnownError(res, error)) return;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    "/internal/apply-subscription-period-budgets",
    async (req: Request, res: Response) => {
      if (!ensureInternalOrCronAuth(req, res)) return;

      try {
        const response = await applySubscriptionPeriodBudgetsWithLock();
        res.status(200).json(response);
      } catch (error: unknown) {
        if (respondKnownError(res, error)) return;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    "/internal/captain-report",
    async (req: Request, res: Response) => {
      if (!ensureInternalOrCronAuth(req, res)) return;

      try {
        const report = await buildCaptainReport();
        res.status(200).json(report);
      } catch (error: unknown) {
        if (respondKnownError(res, error)) return;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        res.status(500).json({ error: message });
      }
    },
  );

  router.get("/subscribe", async (req: Request, res: Response) => {
    const token =
      typeof req.query.token === "string" ? req.query.token.trim() : "";

    try {
      await assertSubscribeTokenUsable(token);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        res.status(error.status).send(error.message);
        return;
      }
      res
        .status(500)
        .send(
          `Payment service unavailable: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderSubscribePage(token));
  });

  router.post("/create-checkout", async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as { token?: string; plan?: string };
      const response = await createCheckoutSession(req, body);
      res.status(200).json(response);
    } catch (error: unknown) {
      if (respondKnownError(res, error)) return;
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  router.get("/success", (req: Request, res: Response) => {
    const mode =
      typeof req.query.mode === "string" ? req.query.mode : undefined;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderSuccessPage(mode));
  });

  router.get("/cancel", (req: Request, res: Response) => {
    void req;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderCancelPage());
  });

  router.post("/cancel-subscription", async (req: Request, res: Response) => {
    const auth = verifyInternalApiKey(req);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason });
      return;
    }

    try {
      const body = req.body as Record<string, unknown> | undefined;
      const response = await cancelStripeSubscription(body?.telegram_user_id);
      res.status(200).json(response);
    } catch (error: unknown) {
      if (respondKnownError(res, error)) return;
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  return router;
};

export const createPaymentWebhookRouter = (): Router => {
  const router = Router();

  router.post(
    "/webhook/stripe",
    express.raw({ type: "*/*" }),
    async (req: Request, res: Response) => {
      try {
        requireStripe();
        requireStripeWebhookSecret();
      } catch (error: unknown) {
        if (respondKnownError(res, error)) return;
        res.status(500).json({ error: "Payment service is not configured" });
        return;
      }

      const sig =
        typeof req.headers["stripe-signature"] === "string"
          ? req.headers["stripe-signature"]
          : "";
      if (!sig) {
        res.status(400).json({ error: "Missing stripe-signature header" });
        return;
      }

      const body = Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === "string"
          ? Buffer.from(req.body)
          : Buffer.from(JSON.stringify(req.body ?? {}));

      let event;
      try {
        event = constructStripeEvent(body, sig);
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : "Unknown signature verification error";
        console.error("Webhook signature verification failed:", message);
        res.status(400).send(`Webhook Error: ${message}`);
        return;
      }

      try {
        const processed = await processStripeEvent(event);
        res.status(200).json({ received: true, ...processed });
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown webhook handler error";
        console.error("Webhook handler error:", error);
        res.status(500).json({ error: message });
      }
    },
  );

  return router;
};

export const registerPaymentWebhookRoutes = (app: Application): void => {
  app.use("/api/payment", createPaymentWebhookRouter());
};

export const registerPaymentRoutes = (app: Application): void => {
  app.use("/api/payment", createPaymentRouter());
};
