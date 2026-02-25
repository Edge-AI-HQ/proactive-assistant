import crypto from "node:crypto";
import Stripe from "stripe";
import type { Request } from "express";
import { DomainError } from "../common/errors.js";
import { db } from "./db.js";
import { getStripePriceIdForPlanCode } from "./planCatalog.js";
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

const resolveStripePriceIdOrThrow = (planCode: string): string => {
  const priceId = getStripePriceIdForPlanCode(planCode);
  if (!priceId) {
    throw new DomainError(
      "INTERNAL",
      `Missing Stripe price ID configuration for plan "${planCode}"`,
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
    plans: plans.map((plan) => {
      const name = plan.display_name.trim() || plan.plan_code;
      const priceId = resolveStripePriceIdOrThrow(plan.plan_code);

      return {
        id: plan.plan_code,
        name,
        price: (plan.price_cents_monthly / 100).toFixed(2),
        priceId,
        description: `${name} subscription`,
        features: [
          `${plan.daily_refresh_credits} credits daily refresh (non-cumulative)`,
          `${plan.monthly_refresh_credits} credits monthly refresh (non-cumulative)`,
          "100 credits = $1 usage budget",
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

  const sessionPayload: {
    token: string;
    telegram_user_id: string;
    expires_at: string;
    telegram_username?: string;
  } = {
    token,
    telegram_user_id: telegramUserId,
    expires_at: expiresAt,
  };
  if (telegramUsername) sessionPayload.telegram_username = telegramUsername;
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
  subscription: Awaited<ReturnType<typeof db.getSubscriptionByTelegramId>>;
}> => {
  const telegramUserId = parseTelegramUserId(telegramUserIdRaw);
  if (!telegramUserId) {
    throw new DomainError("INVALID_INPUT", "telegram_user_id is required");
  }
  const subscription = await db.getSubscriptionByTelegramId(telegramUserId);
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

export const createCheckoutSession = async (
  req: Request,
  body: { token?: string; plan?: string },
): Promise<{ url: string | null }> => {
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
  const stripePriceId = resolveStripePriceIdOrThrow(selectedPlan.plan_code);

  const telegramUserId = session.telegram_user_id;
  const telegramUsername = session.telegram_username;

  const existingSub = await db.getSubscriptionByTelegramId(telegramUserId);
  let customerId = existingSub?.stripe_customer_id ?? null;
  let existingStripeSubscription: Stripe.Subscription | null = null;

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
    const upsertPayload: {
      telegram_user_id: string;
      stripe_customer_id: string;
      plan_id: string;
      telegram_username?: string;
    } = {
      telegram_user_id: telegramUserId,
      stripe_customer_id: customerId,
      plan_id: selectedPlan.plan_code,
    };
    if (telegramUsername) upsertPayload.telegram_username = telegramUsername;
    await db.upsertUserSubscription(upsertPayload);
  }

  if (existingSub?.stripe_subscription_id) {
    try {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        existingSub.stripe_subscription_id,
      );
      if (isStripeSubscriptionOpen(stripeSubscription.status)) {
        existingStripeSubscription = stripeSubscription;
      }
    } catch {
      // If retrieve fails, we will fallback to customer-wide lookup below.
    }
  }

  if (!existingStripeSubscription && customerId) {
    try {
      const candidates = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 20,
      });
      const openSub = candidates.data.find((item) =>
        isStripeSubscriptionOpen(item.status),
      );
      if (openSub) {
        existingStripeSubscription = openSub;
      }
    } catch {
      // Ignore listing failures and fallback to creating a checkout session.
    }
  }

  if (existingStripeSubscription && customerId) {
    const subscriptionItemId = readCurrentSubscriptionItemId(
      existingStripeSubscription,
    );
    const currentPriceId = readCurrentSubscriptionPriceId(
      existingStripeSubscription,
    );

    if (!subscriptionItemId || !currentPriceId) {
      throw new DomainError(
        "INTERNAL",
        "Existing subscription is missing a valid plan item",
        500,
      );
    }

    if (currentPriceId !== stripePriceId) {
      const switched = await stripe.subscriptions.update(
        existingStripeSubscription.id,
        {
          items: [{ id: subscriptionItemId, price: stripePriceId }],
          proration_behavior: "create_prorations",
          metadata: {
            telegram_user_id: telegramUserId,
            telegram_username: telegramUsername || "",
            plan: selectedPlan.plan_code,
          },
        },
      );

      const upsertPayload: {
        telegram_user_id: string;
        stripe_customer_id: string;
        stripe_subscription_id: string;
        plan_id: string;
        telegram_username?: string;
      } = {
        telegram_user_id: telegramUserId,
        stripe_customer_id: customerId,
        stripe_subscription_id: switched.id,
        plan_id: selectedPlan.plan_code,
      };
      if (telegramUsername) upsertPayload.telegram_username = telegramUsername;
      await db.upsertUserSubscription(upsertPayload);

      const switchedPeriodStart = parseUnixSecondsToDate(
        switched.current_period_start,
      );
      const switchedPeriodEnd = parseUnixSecondsToDate(
        switched.current_period_end,
      );
      const switchedEndedAt = parseUnixSecondsToDate(switched.ended_at);
      await db.updateSubscriptionStatus(
        telegramUserId,
        switched.status,
        switchedPeriodStart,
        switchedPeriodEnd,
        Boolean(switched.cancel_at_period_end),
        switchedEndedAt,
        switched.status,
      );

      if (switched.status === "active" || switched.status === "trialing") {
        await syncLiteLLMBudgetFromPlan({
          telegram_user_id: telegramUserId,
          telegram_username: telegramUsername,
          plan_code: selectedPlan.plan_code,
          source: "checkout_plan_switch",
        });
      }

      await db.markPaymentSessionUsed(token);
      return {
        url: `${landingBaseUrl}/api/payment/success?mode=plan_switched`,
      };
    }

    const upsertPayload: {
      telegram_user_id: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
      plan_id: string;
      telegram_username?: string;
    } = {
      telegram_user_id: telegramUserId,
      stripe_customer_id: customerId,
      stripe_subscription_id: existingStripeSubscription.id,
      plan_id: selectedPlan.plan_code,
    };
    if (telegramUsername) upsertPayload.telegram_username = telegramUsername;
    await db.upsertUserSubscription(upsertPayload);
    await syncLiteLLMBudgetFromPlan({
      telegram_user_id: telegramUserId,
      telegram_username: telegramUsername,
      plan_code: selectedPlan.plan_code,
      source: "checkout_existing_subscription",
    });
    await db.markPaymentSessionUsed(token);
    return { url: `${landingBaseUrl}/api/payment/success?mode=already_active` };
  }

  let checkoutSession: Stripe.Checkout.Session;
  try {
    checkoutSession = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: "subscription",
        line_items: [
          {
            price: stripePriceId,
            quantity: 1,
          },
        ],
        success_url: `${landingBaseUrl}/api/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${landingBaseUrl}/api/payment/subscribe?token=${token}`,
        metadata: {
          telegram_user_id: telegramUserId,
          telegram_username: telegramUsername || "",
          plan: selectedPlan.plan_code,
          payment_token: token,
        },
        subscription_data: {
          metadata: {
            telegram_user_id: telegramUserId,
            telegram_username: telegramUsername || "",
            plan: selectedPlan.plan_code,
          },
        },
      },
      {
        idempotencyKey: `checkout:${token}`,
      },
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

  return { url: checkoutSession.url };
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

  const subscription = await db.getSubscriptionByTelegramId(telegramUserId);
  if (!subscription || !subscription.stripe_subscription_id) {
    throw new DomainError("NOT_FOUND", "Active subscription not found");
  }

  const updated = await stripe.subscriptions.update(
    subscription.stripe_subscription_id,
    {
      cancel_at_period_end: true,
    },
  );

  const updatedEndedAt = parseUnixSecondsToDate(updated.ended_at);
  await db.updateSubscriptionStatus(
    telegramUserId,
    updated.status,
    new Date(updated.current_period_start * 1000),
    new Date(updated.current_period_end * 1000),
    true,
    updatedEndedAt,
    updated.status,
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
