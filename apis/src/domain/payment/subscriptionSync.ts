import Stripe from "stripe";
import { db, type UserSubscription } from "./db.js";
import {
  syncLiteLLMBudgetAbsolute,
  syncLiteLLMBudgetFromPlan,
} from "./litellmBudget.js";
import {
  listAssistantsByOwnerTelegramId,
  getUserByTelegramId,
} from "../common/db/index.js";
import {
  stopAssistantContainer,
  ensureAssistantContainer,
} from "../container/index.js";

const parseUnixSecondsToDate = (value: unknown): Date | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const parsed = new Date(value * 1000);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
};

const readSubscriptionPriceId = (
  subscription: Stripe.Subscription,
): string | null => {
  const firstItem = subscription.items.data[0];
  if (!firstItem) return null;
  return firstItem.price?.id || null;
};

const readInvoicePriceId = (invoice: Stripe.Invoice): string | null => {
  for (const line of invoice.lines.data) {
    if (line.price?.id) return line.price.id;
  }
  return null;
};

const resolvePlanCodeFromSubscription = async (
  subscription: Stripe.Subscription,
): Promise<string | null> => {
  const fromMetadata = subscription.metadata?.plan?.trim();
  if (fromMetadata) return fromMetadata;

  const priceId = readSubscriptionPriceId(subscription);
  if (!priceId) return null;

  const plan = await db.getPlanByStripePriceId(priceId);
  return plan?.plan_code ?? null;
};

const resolvePlanCodeFromInvoice = async (
  invoice: Stripe.Invoice,
  subscription: UserSubscription | null,
): Promise<string | null> => {
  const fromMetadata = invoice.metadata?.plan?.trim();
  if (fromMetadata) return fromMetadata;

  const priceId = readInvoicePriceId(invoice);
  if (priceId) {
    const byPrice = await db.getPlanByStripePriceId(priceId);
    if (byPrice?.plan_code) return byPrice.plan_code;
  }

  return subscription?.plan_id ?? null;
};

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const telegram_user_id = session.metadata?.telegram_user_id?.trim();
  const payment_token = session.metadata?.payment_token;
  const plan = session.metadata?.plan;

  if (!telegram_user_id) {
    throw new Error(
      "checkout.session.completed missing metadata.telegram_user_id",
    );
  }

  const payload: {
    telegram_user_id: string;
    stripe_customer_id: string;
    stripe_subscription_id: string;
    telegram_username?: string;
    plan_id?: string;
  } = {
    telegram_user_id,
    stripe_customer_id: session.customer as string,
    stripe_subscription_id: session.subscription as string,
  };

  const username = session.metadata?.telegram_username;
  if (typeof username === "string" && username.trim())
    payload.telegram_username = username.trim();
  if (typeof plan === "string" && plan.trim()) payload.plan_id = plan.trim();

  await db.upsertUserSubscription(payload);

  if (payment_token) {
    await db.markPaymentSessionUsed(payment_token);
  }
}

async function resolveTelegramUserIdForSubscription(
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const fromMetadata = subscription.metadata?.telegram_user_id?.trim();
  if (fromMetadata) return fromMetadata;

  const bySubId = await db.getSubscriptionByStripeSubscriptionId(
    subscription.id,
  );
  if (bySubId?.telegram_user_id) return bySubId.telegram_user_id;

  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  if (!customerId) return null;

  const byCustomer = await db.getSubscriptionByStripeCustomerId(customerId);
  if (byCustomer?.telegram_user_id) return byCustomer.telegram_user_id;

  return null;
}

export async function syncSubscriptionFromStripe(
  subscription: Stripe.Subscription,
  eventContext?: {
    event_id?: string;
    event_created?: number;
  },
): Promise<void> {
  const telegram_user_id =
    await resolveTelegramUserIdForSubscription(subscription);
  if (!telegram_user_id) {
    console.warn(
      "Unable to resolve telegram_user_id for subscription event",
      subscription.id,
    );
    return;
  }

  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  if (!customerId) {
    throw new Error(`Subscription ${subscription.id} missing customer id`);
  }

  const periodStart = parseUnixSecondsToDate(subscription.current_period_start);
  const periodEnd = parseUnixSecondsToDate(subscription.current_period_end);
  const endedAt = parseUnixSecondsToDate(subscription.ended_at);

  // Use Stripe status directly (all 8 statuses)
  const status = subscription.status;
  const stripeStatus = subscription.status;
  const planCode = await resolvePlanCodeFromSubscription(subscription);

  const payload: {
    telegram_user_id: string;
    stripe_customer_id: string;
    stripe_subscription_id: string;
    telegram_username?: string;
    plan_id?: string;
  } = {
    telegram_user_id,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
  };
  const username = subscription.metadata?.telegram_username;
  if (typeof username === "string" && username.trim())
    payload.telegram_username = username.trim();
  if (planCode) payload.plan_id = planCode;

  await db.upsertUserSubscription(payload);

  const applied = await db.updateSubscriptionStatus(
    telegram_user_id,
    status,
    periodStart ?? undefined,
    periodEnd ?? undefined,
    typeof subscription.cancel_at_period_end === "boolean"
      ? subscription.cancel_at_period_end
      : undefined,
    endedAt ?? undefined,
    stripeStatus,
    eventContext?.event_created,
    eventContext?.event_id,
  );
  if (!applied) {
    console.warn("Skipping stale subscription update event", {
      subscriptionId: subscription.id,
      telegramUserId: telegram_user_id,
      eventId: eventContext?.event_id,
      eventCreated: eventContext?.event_created,
    });
    return;
  }

  const telegramUsername = payload.telegram_username ?? null;

  // Determine if user should have service
  // Service is provided if:
  // 1. Status is active, trialing, or past_due (grace period)
  // 2. If cancel_at_period_end is true, check if still within period
  const activeStatuses: Stripe.Subscription.Status[] = [
    "active",
    "trialing",
    "past_due",
  ];
  const hasActiveStatus = activeStatuses.includes(status);

  const isWithinPeriod =
    subscription.cancel_at_period_end && periodEnd
      ? new Date(periodEnd) > new Date()
      : true;

  const shouldProvideService = hasActiveStatus && isWithinPeriod && planCode;

  if (shouldProvideService) {
    await syncLiteLLMBudgetFromPlan({
      telegram_user_id,
      telegram_username: telegramUsername,
      plan_code: planCode!,
      source: "stripe_subscription_sync",
    });

    // Start containers for pending/stopped assistants
    try {
      const user = await getUserByTelegramId(Number(telegram_user_id));
      if (user) {
        const assistants = await listAssistantsByOwnerTelegramId(
          Number(telegram_user_id),
        );
        for (const assistant of assistants) {
          if (
            assistant.container_status === "pending" ||
            assistant.container_status === "stopped"
          ) {
            try {
              await ensureAssistantContainer(assistant, user.gateway_token);
              console.log(
                `Started container for assistant ${assistant.id} after subscription sync`,
              );
            } catch (error: unknown) {
              console.error(
                `Failed to start container for assistant ${assistant.id}`,
                {
                  assistantId: assistant.id,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
          }
        }
      }
    } catch (error: unknown) {
      console.error("Failed to start containers after subscription sync", {
        telegramUserId: telegram_user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  // No service - stop containers and set budget to 0
  await syncLiteLLMBudgetAbsolute({
    telegram_user_id,
    telegram_username: telegramUsername,
    budget_usd: 0,
    source: "stripe_subscription_sync",
    metadata: {
      subscription_status: status,
      plan_code: planCode,
      cancel_at_period_end: subscription.cancel_at_period_end,
    },
  });

  // Stop all running containers
  try {
    const assistants = await listAssistantsByOwnerTelegramId(
      Number(telegram_user_id),
    );
    for (const assistant of assistants) {
      if (assistant.container_status === "running") {
        await stopAssistantContainer(assistant);
        console.log(
          `Stopped container for assistant ${assistant.id} due to inactive subscription`,
        );
      }
    }
  } catch (error: unknown) {
    console.error("Failed to stop containers for inactive subscription", {
      telegramUserId: telegram_user_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  console.warn("Skipping LiteLLM budget sync due to missing active plan code", {
    subscriptionId: subscription.id,
    telegramUserId: telegram_user_id,
    status: subscription.status,
  });
}

const resolveSubscriptionFromInvoice = async (
  invoice: Stripe.Invoice,
): Promise<UserSubscription | null> => {
  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;
  if (subscriptionId) {
    const bySub =
      await db.getSubscriptionByStripeSubscriptionId(subscriptionId);
    if (bySub) return bySub;
  }

  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (customerId) {
    const byCustomer = await db.getSubscriptionByStripeCustomerId(customerId);
    if (byCustomer) return byCustomer;
  }

  const telegramUserId = invoice.metadata?.telegram_user_id?.trim();
  if (telegramUserId) {
    const byTelegram = await db.getSubscriptionByTelegramId(telegramUserId);
    if (byTelegram) return byTelegram;
  }

  return null;
};

export async function handleInvoicePaid(
  eventId: string,
  invoice: Stripe.Invoice,
): Promise<void> {
  const subscription = await resolveSubscriptionFromInvoice(invoice);
  if (!subscription?.telegram_user_id) {
    console.warn(
      "invoice.paid could not resolve subscription user",
      invoice.id || eventId,
    );
    return;
  }

  const planCode = await resolvePlanCodeFromInvoice(invoice, subscription);
  if (!planCode) {
    console.warn("invoice.paid missing plan code", {
      invoiceId: invoice.id,
      subscriptionId: subscription.stripe_subscription_id,
      telegramUserId: subscription.telegram_user_id,
    });
    return;
  }

  await syncLiteLLMBudgetFromPlan({
    telegram_user_id: subscription.telegram_user_id,
    telegram_username: subscription.telegram_username,
    plan_code: planCode,
    source: "stripe_invoice_paid",
  });
}
