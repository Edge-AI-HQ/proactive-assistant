import crypto from "node:crypto";
import Stripe from "stripe";
import type { Request } from "express";
import { DomainError } from "../common/errors.js";
import { db } from "./db.js";
import { syncLiteLLMBudgetFromPlan } from "./litellmBudget.js";
import { readPaymentPublicBaseUrl } from "./publicBaseUrl.js";
import { parseTelegramUserId, requireStripe } from "./stripeClient.js";

// Local mapping for checkout API backward compatibility
const mapStripeSubscriptionStatus = (
  status: Stripe.Subscription.Status,
): "active" | "paused" | "canceled" | "pending" => {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "canceled":
    case "incomplete_expired":
    case "unpaid":
      return "canceled";
    case "past_due":
    case "paused":
      return "paused";
    case "incomplete":
    default:
      return "pending";
  }
};

const parseTtlSeconds = (value: unknown): number => {
  const ttlRaw = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(ttlRaw)
    ? Math.min(24 * 60 * 60, Math.max(5 * 60, ttlRaw))
    : 60 * 60;
};

const requireStripePriceId = (plan: {
  plan_code: string;
  stripe_price_id: string;
}): string => {
  const priceId = (plan.stripe_price_id || "").trim();
  if (!priceId) {
    throw new DomainError(
      "INTERNAL",
      `Missing Stripe price ID for plan "${plan.plan_code}" (set in billing_plans.stripe_price_id)`,
      500,
    );
  }
  return priceId;
};

const parseUnixSecondsToDate = (value: unknown): Date | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const parsed = new Date(value * 1000);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return parsed;
};

const isStripeSubscriptionOpen = (
  status: Stripe.Subscription.Status,
): boolean => {
  return !["canceled", "incomplete_expired", "unpaid"].includes(status);
};

const readCurrentSubscriptionPriceId = (
  subscription: Stripe.Subscription,
): string | null => {
  const firstItem = subscription.items.data[0];
  return firstItem?.price?.id ?? null;
};

const readCurrentSubscriptionItemId = (
  subscription: Stripe.Subscription,
): string | null => {
  const firstItem = subscription.items.data[0];
  return firstItem?.id ?? null;
};

export const listActivePlansForApi = async (): Promise<{
  plans: Array<{
    id: string;
    name: string;
    price: string;
    priceId: string;
    description: string;
    features: string[];
    popular: boolean;
  }>;
}> => {
  const plans = await db.listActivePlans();
  return {
    plans: plans
      .filter((plan) => (plan.stripe_price_id || "").trim())
      .map((plan) => {
        const name = plan.display_name.trim() || plan.plan_code;
        const priceId = requireStripePriceId(plan);

        return {
          id: plan.plan_code,
          name,
          price: (plan.price_cents_monthly / 100).toFixed(2),
          priceId,
          description: `${name} subscription`,
          features: [
            `${plan.monthly_refresh_credits} credits per month`,
            "100 credits = $1 usage budget",
            "Credits reset each billing cycle",
          ],
          popular: plan.plan_code === "pro",
        };
      }),
  };
};

export const createInternalPaymentSession = async (
  req: Request,
  body: Record<string, unknown> | undefined,
): Promise<{ token: string; expires_at: string; subscribe_url: string }> => {
  const telegramUserId = parseTelegramUserId(body?.telegram_user_id);
  if (!telegramUserId) {
    throw new DomainError(
      "INVALID_INPUT",
      "Invalid body. telegram_user_id is required.",
    );
  }

  const telegramUsername =
    typeof body?.telegram_username === "string" && body.telegram_username.trim()
      ? body.telegram_username.trim()
      : undefined;

  const ttlSeconds = parseTtlSeconds(body?.ttl_seconds);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const subscribeUrl = `${readPaymentPublicBaseUrl(req)}/api/payment/subscribe?token=${encodeURIComponent(token)}`;

  // 解析 assistant_id（可选，用于助理级订阅）
  let assistantId: number | undefined = undefined;
  if (body?.assistant_id !== undefined && body?.assistant_id !== null) {
    if (
      typeof body.assistant_id === "number" &&
      Number.isFinite(body.assistant_id)
    ) {
      assistantId = Math.trunc(body.assistant_id);
    } else if (typeof body.assistant_id === "string") {
      const parsed = Number.parseInt(body.assistant_id, 10);
      if (Number.isFinite(parsed)) assistantId = parsed;
    }
  }

  const sessionPayload: {
    token: string;
    telegram_user_id: string;
    expires_at: string;
    telegram_username?: string;
    assistant_id?: number;
    plan_code?: string;
  } = {
    token,
    telegram_user_id: telegramUserId,
    expires_at: expiresAt,
  };
  if (telegramUsername) sessionPayload.telegram_username = telegramUsername;
  if (assistantId) sessionPayload.assistant_id = assistantId;
  if (typeof body?.plan_code === "string" && body.plan_code.trim()) {
    sessionPayload.plan_code = body.plan_code.trim();
  }
  await db.createPaymentSession(sessionPayload);

  return {
    token,
    expires_at: expiresAt,
    subscribe_url: subscribeUrl,
  };
};

export const readInternalSubscription = async (
  telegramUserIdRaw: unknown,
): Promise<{
  subscription: Awaited<ReturnType<typeof db.getCurrentPeriodByTelegramId>>;
}> => {
  const telegramUserId = parseTelegramUserId(telegramUserIdRaw);
  if (!telegramUserId) {
    throw new DomainError("INVALID_INPUT", "telegram_user_id is required");
  }
  const subscription = await db.getCurrentPeriodByTelegramId(telegramUserId);
  return { subscription };
};

export const validateInternalPaymentSession = async (
  tokenRaw: unknown,
): Promise<{
  token: string;
  telegram_user_id: string;
  telegram_username: string | null;
  used: false;
  expires_at: string;
}> => {
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  if (!token) {
    throw new DomainError("INVALID_INPUT", "token is required");
  }

  const session = await db.getPaymentSessionByToken(token);
  if (!session) {
    throw new DomainError("NOT_FOUND", "Invalid token");
  }

  if (session.used) {
    throw new DomainError("INVALID_INPUT", "Token already used");
  }

  if (new Date(session.expires_at) < new Date()) {
    throw new DomainError("INVALID_INPUT", "Token expired");
  }

  return {
    token: session.token,
    telegram_user_id: session.telegram_user_id,
    telegram_username: session.telegram_username,
    used: false,
    expires_at: new Date(session.expires_at).toISOString(),
  };
};

export const assertSubscribeTokenUsable = async (
  tokenRaw: unknown,
): Promise<void> => {
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  if (!token) {
    throw new DomainError("INVALID_INPUT", "Invalid or missing token");
  }

  const session = await db.getPaymentSessionByToken(token);
  if (!session) {
    throw new DomainError("NOT_FOUND", "Invalid token");
  }
  if (session.used) {
    throw new DomainError("INVALID_INPUT", "Token already used");
  }
  if (new Date(session.expires_at) < new Date()) {
    throw new DomainError("INVALID_INPUT", "Token expired");
  }
};

export interface CheckoutResult {
  url: string | null;
  action?: "checkout" | "upgrade" | "downgrade";
  message?: string;
}

export const createCheckoutSession = async (
  req: Request,
  body: { token?: string; plan?: string },
): Promise<CheckoutResult> => {
  const stripe = requireStripe();
  const token = String(body.token || "").trim();
  const planCode =
    String(body.plan || "")
      .trim()
      .toLowerCase() || "basic";
  const landingBaseUrl = readPaymentPublicBaseUrl(req);

  if (!token) {
    throw new DomainError("INVALID_INPUT", "Token is required");
  }

  const session = await db.getPaymentSessionByToken(token);
  if (!session) {
    throw new DomainError("NOT_FOUND", "Invalid token");
  }

  if (session.used) {
    throw new DomainError("INVALID_INPUT", "Token already used");
  }

  if (new Date(session.expires_at) < new Date()) {
    throw new DomainError("INVALID_INPUT", "Token expired");
  }

  const selectedPlan = await db.getPlanByCode(planCode);
  if (!selectedPlan || !selectedPlan.is_active) {
    throw new DomainError("INVALID_INPUT", "Invalid plan");
  }
  const stripePriceId = requireStripePriceId(selectedPlan);

  const telegramUserId = session.telegram_user_id;
  const telegramUsername = session.telegram_username;

  const existingSub = await db.getCurrentPeriodByTelegramId(telegramUserId);
  let customerId = existingSub?.stripe_customer_id ?? null;

  if (customerId) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if ("deleted" in customer && customer.deleted) {
        customerId = null;
      }
    } catch {
      customerId = null;
    }
  }

  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: {
        telegram_user_id: telegramUserId,
        telegram_username: telegramUsername || "",
      },
    });
    customerId = customer.id;
  }

  // --- Handle existing active subscription: upgrade / downgrade / same plan ---
  if (existingSub?.stripe_subscription_id && existingSub.plan_id) {
    const currentPlan = await db.getPlanByCode(existingSub.plan_id);
    if (currentPlan) {
      let stripeSubActive = false;
      let stripeSubscription: Stripe.Subscription | null = null;
      try {
        stripeSubscription = await stripe.subscriptions.retrieve(
          existingSub.stripe_subscription_id,
        );
        stripeSubActive = isStripeSubscriptionOpen(stripeSubscription.status);
      } catch {
        /* subscription may not exist in Stripe anymore */
      }

      if (stripeSubActive && stripeSubscription) {
        // 已有活跃订阅，暂不支持升降配
        throw new DomainError(
          "INVALID_INPUT",
          `You already have an active ${currentPlan.display_name} subscription.`,
        );
      }
    }
  }

  // --- Create new checkout session (new subscription or upgrade) ---
  let checkoutSession: Stripe.Checkout.Session;
  try {
    checkoutSession = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: stripePriceId, quantity: 1 }],
        success_url: `${landingBaseUrl}/api/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${landingBaseUrl}/api/payment/subscribe?token=${token}`,
        metadata: {
          telegram_user_id: telegramUserId,
          telegram_username: telegramUsername || "",
          plan: selectedPlan.plan_code,
          payment_token: token,
          ...(session.assistant_id
            ? { assistant_id: String(session.assistant_id) }
            : {}),
        },
        subscription_data: {
          metadata: {
            telegram_user_id: telegramUserId,
            telegram_username: telegramUsername || "",
            plan: selectedPlan.plan_code,
            ...(session.assistant_id
              ? { assistant_id: String(session.assistant_id) }
              : {}),
          },
        },
      },
      { idempotencyKey: `checkout:${token}` },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("idempotent")) {
      throw new DomainError(
        "INVALID_INPUT",
        "A checkout session already exists for this payment link. Please refresh and retry.",
        409,
      );
    }
    throw error;
  }

  return { url: checkoutSession.url, action: "checkout" };
};

export const cancelStripeSubscription = async (
  telegramUserIdRaw: unknown,
): Promise<{
  ok: true;
  status: "active" | "paused" | "canceled" | "pending";
  cancel_at_period_end: true;
  current_period_end: string;
}> => {
  const stripe = requireStripe();
  const telegramUserId = parseTelegramUserId(telegramUserIdRaw);
  if (!telegramUserId) {
    throw new DomainError("INVALID_INPUT", "telegram_user_id is required");
  }

  const subscription = await db.getCurrentPeriodByTelegramId(telegramUserId);
  if (!subscription || !subscription.stripe_subscription_id) {
    throw new DomainError("NOT_FOUND", "Active subscription not found");
  }

  const updated = await stripe.subscriptions.update(
    subscription.stripe_subscription_id,
    {
      cancel_at_period_end: true,
    },
  );

  return {
    ok: true,
    status: mapStripeSubscriptionStatus(updated.status),
    cancel_at_period_end: true,
    current_period_end: new Date(
      updated.current_period_end * 1000,
    ).toISOString(),
  };
};
