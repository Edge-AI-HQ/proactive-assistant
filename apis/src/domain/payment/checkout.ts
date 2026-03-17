import crypto from "node:crypto";
import Stripe from "stripe";
import type { Request } from "express";
import { DomainError } from "../common/errors.js";
import {
  setLogContextTelegramIdentity,
  setLogContextTelegramUserId,
} from "../common/requestLogContext.js";
import { db } from "./db.js";
import { syncLiteLLMBudgetFromPlan } from "./litellmBudget.js";
import { readPaymentPublicBaseUrl } from "./publicBaseUrl.js";
import { parseTelegramUserId, requireStripe, stripe } from "./stripeClient.js";

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

const parseUnixSeconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
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

const summarizeToken = (token: string): string => {
  return token || "";
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
  setLogContextTelegramIdentity(telegramUserId, telegramUsername);
  console.log("[payment] create_internal_session:start", {
    telegram_user_id: telegramUserId,
    ttl_seconds: ttlSeconds,
    token_ref: summarizeToken(token),
  });

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
  console.log("[payment] create_internal_session:ok", {
    telegram_user_id: telegramUserId,
    assistant_id: assistantId ?? null,
    plan_code: sessionPayload.plan_code ?? null,
    expires_at: expiresAt,
    token_ref: summarizeToken(token),
  });

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
  downgrade_lock_until: string | null;
  pending_plan_id: string | null;
}> => {
  const telegramUserId = parseTelegramUserId(telegramUserIdRaw);
  if (!telegramUserId) {
    throw new DomainError("INVALID_INPUT", "telegram_user_id is required");
  }
  const subscription = await db.getCurrentPeriodByTelegramId(telegramUserId);
  
  let downgradeLockUntil: string | null = null;
  let pendingPlanId: string | null = null;
  if (subscription?.stripe_subscription_id) {
    try {
      const stripeSub = await requireStripe().subscriptions.retrieve(
        subscription.stripe_subscription_id,
      );
      const lockUntilRaw = stripeSub.metadata?.pinai_downgrade_lock_until;
      if (lockUntilRaw) {
        const lockTimestamp = Number.parseInt(lockUntilRaw, 10);
        if (Number.isFinite(lockTimestamp) && lockTimestamp > Date.now() / 1000) {
          downgradeLockUntil = new Date(lockTimestamp * 1000).toISOString();
        }
      }

      const metadataPlan = stripeSub.metadata?.plan?.trim().toLowerCase() || null;
      const currentPlan = subscription.plan_id?.trim().toLowerCase() || null;
      if (metadataPlan && currentPlan && metadataPlan !== currentPlan) {
        const [metadataPlanRecord, currentPlanRecord] = await Promise.all([
          db.getPlanByCode(metadataPlan),
          db.getPlanByCode(currentPlan),
        ]);

        // Only expose a pending plan for next-cycle downgrades.
        // Upgrades should be treated as immediate and not shown as "scheduled downgrade".
        if (
          metadataPlanRecord &&
          currentPlanRecord &&
          metadataPlanRecord.price_cents_monthly < currentPlanRecord.price_cents_monthly
        ) {
          pendingPlanId = metadataPlan;
        }
      }
    } catch (err) {
      // Non-fatal, just won't show lock info
      console.warn("[payment] Failed to read downgrade lock from Stripe", {
        subscriptionId: subscription.stripe_subscription_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  
  return {
    subscription,
    downgrade_lock_until: downgradeLockUntil,
    pending_plan_id: pendingPlanId,
  };
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

export interface PromotionPreviewResult {
  valid: boolean;
  original_price: string;
  discounted_price: string | null;
  discount_label: string | null;
  duration_label: string | null;
  message: string | null;
}

const normalizePromotionCode = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
};

const resolvePromotionCodeId = async (
  stripeClient: Stripe,
  promotionCode: string,
): Promise<string> => {
  const result = await stripeClient.promotionCodes.list({
    code: promotionCode,
    active: true,
    limit: 1,
  });
  const match = result.data[0];
  if (!match) {
    throw new DomainError(
      "INVALID_INPUT",
      "Invalid or inactive promotion code.",
    );
  }
  return match.id;
};

const formatPriceCents = (cents: number): string => {
  return (Math.max(0, cents) / 100).toFixed(2);
};

const readCouponObject = async (
  stripeClient: Stripe,
  promotionCode: string,
): Promise<{
  promotionCode: Stripe.PromotionCode;
  coupon: Stripe.Coupon;
}> => {
  const result = await stripeClient.promotionCodes.list({
    code: promotionCode,
    active: true,
    limit: 1,
  });
  const match = result.data[0];
  if (!match) {
    throw new DomainError(
      "INVALID_INPUT",
      "Invalid or inactive promotion code.",
    );
  }

  const coupon =
    typeof match.coupon === "string"
      ? await stripeClient.coupons.retrieve(match.coupon)
      : match.coupon;

  return { promotionCode: match, coupon };
};

const readCouponDurationLabel = (coupon: Stripe.Coupon): string | null => {
  switch (coupon.duration) {
    case "once":
      return "First payment only";
    case "repeating":
      return coupon.duration_in_months
        ? `First ${coupon.duration_in_months} months`
        : "Limited months";
    case "forever":
      return "Every renewal";
    default:
      return null;
  }
};

export const previewPromotionCode = async (body: {
  plan?: string;
  promotionCode?: string;
}): Promise<PromotionPreviewResult> => {
  const stripeClient = requireStripe();
  const planCode =
    String(body.plan || "")
      .trim()
      .toLowerCase() || "basic";
  const promotionCode = normalizePromotionCode(body.promotionCode);
  const selectedPlan = await db.getPlanByCode(planCode);
  if (!selectedPlan || !selectedPlan.is_active) {
    throw new DomainError("INVALID_INPUT", "Invalid plan");
  }

  const originalPriceCents = selectedPlan.price_cents_monthly ?? 0;
  const originalPrice = formatPriceCents(originalPriceCents);
  if (!promotionCode) {
    return {
      valid: false,
      original_price: originalPrice,
      discounted_price: null,
      discount_label: null,
      duration_label: null,
      message: null,
    };
  }

  const stripePriceId = requireStripePriceId(selectedPlan);
  const [{ coupon }, stripePrice] = await Promise.all([
    readCouponObject(stripeClient, promotionCode),
    stripeClient.prices.retrieve(stripePriceId, { expand: ["product"] }),
  ]);

  const priceCurrency = stripePrice.currency?.toLowerCase() ?? "";
  const productId =
    typeof stripePrice.product === "string"
      ? stripePrice.product
      : stripePrice.product?.id ?? "";
  const appliesToProducts = coupon.applies_to?.products ?? [];
  if (appliesToProducts.length > 0 && !appliesToProducts.includes(productId)) {
    throw new DomainError(
      "INVALID_INPUT",
      "This promotion code does not apply to the selected plan.",
    );
  }

  let discountedPriceCents = originalPriceCents;
  let discountLabel: string | null = null;

  if (typeof coupon.percent_off === "number") {
    discountedPriceCents = Math.round(
      originalPriceCents * (1 - coupon.percent_off / 100),
    );
    discountLabel = `${coupon.percent_off}% off`;
  } else {
    const amountOff =
      typeof coupon.amount_off === "number" &&
      (!coupon.currency || coupon.currency.toLowerCase() === priceCurrency)
        ? coupon.amount_off
        : null;
    if (amountOff === null) {
      throw new DomainError(
        "INVALID_INPUT",
        "This promotion code is not supported for the selected plan.",
      );
    }
    discountedPriceCents = Math.max(0, originalPriceCents - amountOff);
    discountLabel = `$${formatPriceCents(amountOff)} off`;
  }

  return {
    valid: true,
    original_price: originalPrice,
    discounted_price: formatPriceCents(discountedPriceCents),
    discount_label: discountLabel,
    duration_label: readCouponDurationLabel(coupon),
    message: null,
  };
};

export const createCheckoutSession = async (
  req: Request,
  body: {
    token?: string;
    plan?: string;
    successUrl?: string;
    promotionCode?: string;
  },
): Promise<CheckoutResult> => {
  const stripe = requireStripe();
  const token = String(body.token || "").trim();
  const planCode =
    String(body.plan || "")
      .trim()
      .toLowerCase() || "basic";
  const promotionCode = normalizePromotionCode(body.promotionCode);
  const landingBaseUrl = readPaymentPublicBaseUrl(req);

  if (!token) {
    throw new DomainError("INVALID_INPUT", "Token is required");
  }
  console.log("[payment] checkout:start", {
    token_ref: summarizeToken(token),
    plan_code: planCode,
    promotion_code_supplied: Boolean(promotionCode),
  });

  const session = await db.getPaymentSessionByToken(token);
  if (!session) {
    console.warn("[payment] checkout:invalid_token", {
      token_ref: summarizeToken(token),
    });
    throw new DomainError("NOT_FOUND", "Invalid token");
  }

  if (session.used) {
    console.warn("[payment] checkout:token_used", {
      token_ref: summarizeToken(token),
      telegram_user_id: session.telegram_user_id,
    });
    throw new DomainError("INVALID_INPUT", "Token already used");
  }

  if (new Date(session.expires_at) < new Date()) {
    console.warn("[payment] checkout:token_expired", {
      token_ref: summarizeToken(token),
      telegram_user_id: session.telegram_user_id,
      expires_at: session.expires_at,
    });
    throw new DomainError("INVALID_INPUT", "Token expired");
  }

  const selectedPlan = await db.getPlanByCode(planCode);
  if (!selectedPlan || !selectedPlan.is_active) {
    console.warn("[payment] checkout:invalid_plan", {
      token_ref: summarizeToken(token),
      plan_code: planCode,
    });
    throw new DomainError("INVALID_INPUT", "Invalid plan");
  }
  const stripePriceId = requireStripePriceId(selectedPlan);

  const telegramUserId = session.telegram_user_id;
  const telegramUsername = session.telegram_username;
  setLogContextTelegramIdentity(telegramUserId, telegramUsername);
  console.log("[payment] checkout:validated", {
    telegram_user_id: telegramUserId,
    assistant_id: session.assistant_id ?? null,
    plan_code: selectedPlan.plan_code,
    stripe_price_id: stripePriceId,
    token_ref: summarizeToken(token),
  });

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
    console.log("[payment] checkout:stripe_customer_created", {
      telegram_user_id: telegramUserId,
      stripe_customer_id: customerId,
    });
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
        const currentPriceAmount = currentPlan.price_cents_monthly ?? 0;
        const newPriceAmount = selectedPlan.price_cents_monthly ?? 0;

        if (currentPlan.plan_code === selectedPlan.plan_code) {
          console.warn("[payment] checkout:same_plan", {
            telegram_user_id: telegramUserId,
            plan_code: selectedPlan.plan_code,
            stripe_subscription_id: existingSub.stripe_subscription_id,
          });
          throw new DomainError(
            "INVALID_INPUT",
            `You are already on the ${currentPlan.display_name} plan.`,
          );
        }

        if (promotionCode) {
          throw new DomainError(
            "INVALID_INPUT",
            "Promotion codes are only supported for new checkout sessions.",
          );
        }

        const subscriptionItem = stripeSubscription.items.data[0];
        if (!subscriptionItem) {
          throw new DomainError("INTERNAL", "Subscription item not found");
        }

        // Build shared metadata with assistant_id so invoice.paid creates correct period
        const sharedMetadata: Record<string, string> = {
          telegram_user_id: telegramUserId,
          telegram_username: telegramUsername || "",
          plan: selectedPlan.plan_code,
        };
        if (session.assistant_id) {
          sharedMetadata.assistant_id = String(session.assistant_id);
        }

        if (newPriceAmount > currentPriceAmount) {
          const lockUntil =
            parseUnixSeconds(stripeSubscription.current_period_end) ??
            parseUnixSeconds(
              existingSub.current_period_end
                ? Math.floor(
                    new Date(existingSub.current_period_end).getTime() / 1000,
                  )
                : null,
            );
          // Upgrade: apply immediately with proration
          // Also reset cancel_at_period_end — user is actively upgrading, so they want to continue
          await stripe.subscriptions.update(existingSub.stripe_subscription_id, {
            items: [{ id: subscriptionItem.id, price: stripePriceId }],
            proration_behavior: "always_invoice",
            cancel_at_period_end: false,
            metadata: {
              ...sharedMetadata,
              ...(lockUntil
                ? { pinai_downgrade_lock_until: String(lockUntil) }
                : {}),
            },
          });
          // Also update DB period to reflect cancel_at_period_end=false
          await db.updateSubscriptionCancelFlag(
            existingSub.stripe_subscription_id,
            false,
          ).catch(() => {/* non-fatal */});
          await db.markPaymentSessionUsed(token);
          console.log("[payment] checkout:upgrade_applied", {
            telegram_user_id: telegramUserId,
            stripe_subscription_id: existingSub.stripe_subscription_id,
            from_plan: currentPlan.plan_code,
            to_plan: selectedPlan.plan_code,
            token_ref: summarizeToken(token),
          });
          return {
            url: null,
            action: "upgrade",
            message: `Upgraded to ${selectedPlan.display_name}. Effective immediately.`,
          };
        } else {
          if (existingSub.cancel_at_period_end === true) {
            throw new DomainError(
              "INVALID_INPUT",
              "Downgrade is unavailable while renewal is canceled. Resume renewal first.",
            );
          }
          const lockUntil = parseUnixSeconds(
            stripeSubscription.metadata?.pinai_downgrade_lock_until,
          );
          const nowSec = Math.floor(Date.now() / 1000);
          if (lockUntil && nowSec < lockUntil) {
            const lockDate = new Date(lockUntil * 1000).toISOString();
            console.warn("[payment] checkout:downgrade_blocked_by_upgrade_lock", {
              telegram_user_id: telegramUserId,
              stripe_subscription_id: existingSub.stripe_subscription_id,
              from_plan: currentPlan.plan_code,
              to_plan: selectedPlan.plan_code,
              lock_until: lockDate,
            });
            throw new DomainError(
              "INVALID_INPUT",
              `Downgrade is locked until ${lockDate}. You can downgrade after this billing cycle ends.`,
            );
          }
          // Downgrade: schedule for next billing cycle (no proration, no refund)
          await stripe.subscriptions.update(existingSub.stripe_subscription_id, {
            items: [{ id: subscriptionItem.id, price: stripePriceId }],
            proration_behavior: "none",
            billing_cycle_anchor: "unchanged" as const,
            metadata: sharedMetadata,
          });
          await db.markPaymentSessionUsed(token);
          console.log("[payment] checkout:downgrade_scheduled", {
            telegram_user_id: telegramUserId,
            stripe_subscription_id: existingSub.stripe_subscription_id,
            from_plan: currentPlan.plan_code,
            to_plan: selectedPlan.plan_code,
            token_ref: summarizeToken(token),
          });
          return {
            url: null,
            action: "downgrade",
            message: `Downgrade to ${selectedPlan.display_name} scheduled for next billing cycle.`,
          };
        }
      }
    }
  }

  // --- Create new checkout session (new subscription or upgrade) ---
  let checkoutSession: Stripe.Checkout.Session;
  try {
    const promotionCodeId = promotionCode
      ? await resolvePromotionCodeId(stripe, promotionCode)
      : null;
    checkoutSession = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: stripePriceId, quantity: 1 }],
        ...(!promotionCodeId ? { allow_promotion_codes: true } : {}),
        ...(promotionCodeId
          ? { discounts: [{ promotion_code: promotionCodeId }] }
          : {}),
        success_url: body.successUrl || `${landingBaseUrl}/api/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${landingBaseUrl}/api/payment/subscribe?token=${token}`,
        metadata: {
          telegram_user_id: telegramUserId,
          telegram_username: telegramUsername || "",
          plan: selectedPlan.plan_code,
          payment_token: token,
          ...(promotionCode ? { promotion_code: promotionCode } : {}),
          ...(session.assistant_id
            ? { assistant_id: String(session.assistant_id) }
            : {}),
        },
        subscription_data: {
          metadata: {
            telegram_user_id: telegramUserId,
            telegram_username: telegramUsername || "",
            plan: selectedPlan.plan_code,
            ...(promotionCode ? { promotion_code: promotionCode } : {}),
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
      console.warn("[payment] checkout:idempotency_conflict", {
        telegram_user_id: telegramUserId,
        token_ref: summarizeToken(token),
      });
      throw new DomainError(
        "INVALID_INPUT",
        "A checkout session already exists for this payment link. Please refresh and retry.",
        409,
      );
    }
    console.error("[payment] checkout:stripe_create_failed", {
      telegram_user_id: telegramUserId,
      token_ref: summarizeToken(token),
      plan_code: selectedPlan.plan_code,
      error: error instanceof Error ? error.message : String(error ?? ""),
    });
    throw error;
  }

  console.log("[payment] checkout:created", {
    telegram_user_id: telegramUserId,
    token_ref: summarizeToken(token),
    stripe_checkout_session_id: checkoutSession.id,
    stripe_customer_id: customerId,
    plan_code: selectedPlan.plan_code,
  });
  return { url: checkoutSession.url, action: "checkout" };
};

export const cancelStripeSubscriptionImmediately = async (
  telegramUserId: string,
): Promise<void> => {
  if (!stripe) return;
  const subscription = await db.getCurrentPeriodByTelegramId(telegramUserId);
  if (!subscription?.stripe_subscription_id) return;

  try {
    await stripe.subscriptions.cancel(subscription.stripe_subscription_id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("no such subscription") || message.includes("already been canceled")) {
      return;
    }
    throw error;
  }
};

export const cancelStripeSubscription = async (
  telegramUserIdRaw: unknown,
): Promise<{
  ok: true;
  status: "active" | "paused" | "canceled" | "pending";
  cancel_at_period_end: true;
  current_period_end: string;
  already_scheduled?: boolean;
}> => {
  const stripe = requireStripe();
  const telegramUserId = parseTelegramUserId(telegramUserIdRaw);
  if (!telegramUserId) {
    throw new DomainError("INVALID_INPUT", "telegram_user_id is required");
  }
  setLogContextTelegramUserId(telegramUserId);
  console.log("[payment] cancel_subscription:start", {
    telegram_user_id: telegramUserId,
  });

  const subscription = await db.getCurrentPeriodByTelegramId(telegramUserId);
  if (!subscription || !subscription.stripe_subscription_id) {
    console.warn("[payment] cancel_subscription:not_found", {
      telegram_user_id: telegramUserId,
    });
    throw new DomainError("NOT_FOUND", "Active subscription not found");
  }

  if (
    subscription.cancel_at_period_end &&
    typeof subscription.current_period_end === "string" &&
    subscription.current_period_end
  ) {
    console.log("[payment] cancel_subscription:already_scheduled", {
      telegram_user_id: telegramUserId,
      stripe_subscription_id: subscription.stripe_subscription_id,
      current_period_end: subscription.current_period_end,
    });
    return {
      ok: true,
      status: mapStripeSubscriptionStatus(
        subscription.status as Stripe.Subscription.Status,
      ),
      cancel_at_period_end: true,
      current_period_end: subscription.current_period_end,
      already_scheduled: true,
    };
  }

  const updated = await stripe.subscriptions.update(
    subscription.stripe_subscription_id,
    {
      cancel_at_period_end: true,
    },
  );

  const currentPeriodEnd = new Date(
    updated.current_period_end * 1000,
  ).toISOString();
  await db.updateSubscriptionCancelFlag(
    subscription.stripe_subscription_id,
    true,
    updated.status,
  );

  console.log("[payment] cancel_subscription:ok", {
    telegram_user_id: telegramUserId,
    stripe_subscription_id: subscription.stripe_subscription_id,
    current_period_end: currentPeriodEnd,
  });

  return {
    ok: true,
    status: mapStripeSubscriptionStatus(updated.status),
    cancel_at_period_end: true,
    current_period_end: currentPeriodEnd,
  };
};

export const resumeStripeSubscription = async (
  telegramUserIdRaw: unknown,
): Promise<{
  ok: true;
  status: "active" | "paused" | "canceled" | "pending";
  cancel_at_period_end: false;
  current_period_end: string;
  already_active?: boolean;
}> => {
  const stripe = requireStripe();
  const telegramUserId = parseTelegramUserId(telegramUserIdRaw);
  if (!telegramUserId) {
    throw new DomainError("INVALID_INPUT", "telegram_user_id is required");
  }
  setLogContextTelegramUserId(telegramUserId);
  console.log("[payment] resume_subscription:start", {
    telegram_user_id: telegramUserId,
  });

  const subscription = await db.getCurrentPeriodByTelegramId(telegramUserId);
  if (!subscription || !subscription.stripe_subscription_id) {
    console.warn("[payment] resume_subscription:not_found", {
      telegram_user_id: telegramUserId,
    });
    throw new DomainError("NOT_FOUND", "Active subscription not found");
  }

  if (subscription.cancel_at_period_end !== true) {
    console.log("[payment] resume_subscription:already_active", {
      telegram_user_id: telegramUserId,
      stripe_subscription_id: subscription.stripe_subscription_id,
      current_period_end: subscription.current_period_end,
    });
    return {
      ok: true,
      status: mapStripeSubscriptionStatus(
        subscription.status as Stripe.Subscription.Status,
      ),
      cancel_at_period_end: false,
      current_period_end: subscription.current_period_end || "",
      already_active: true,
    };
  }

  const updated = await stripe.subscriptions.update(
    subscription.stripe_subscription_id,
    {
      cancel_at_period_end: false,
    },
  );

  const currentPeriodEnd = new Date(
    updated.current_period_end * 1000,
  ).toISOString();
  await db.updateSubscriptionCancelFlag(
    subscription.stripe_subscription_id,
    false,
    updated.status,
  );

  console.log("[payment] resume_subscription:ok", {
    telegram_user_id: telegramUserId,
    stripe_subscription_id: subscription.stripe_subscription_id,
    current_period_end: currentPeriodEnd,
  });

  return {
    ok: true,
    status: mapStripeSubscriptionStatus(updated.status),
    cancel_at_period_end: false,
    current_period_end: currentPeriodEnd,
  };
};
