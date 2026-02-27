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
import { sendTelegramMessage } from "../telegram/notify.js";

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

  // During upgrade, the old subscription gets deleted while a new one is created.
  // Don't let the old subscription's deleted/canceled event overwrite the newer one.
  const inactiveStatuses: Stripe.Subscription.Status[] = [
    "canceled",
    "incomplete_expired",
    "unpaid",
  ];
  if (inactiveStatuses.includes(status)) {
    const existingDbSub = await db.getSubscriptionByTelegramId(telegram_user_id);
    if (
      existingDbSub?.stripe_subscription_id &&
      existingDbSub.stripe_subscription_id !== subscription.id
    ) {
      console.log("Skipping upsert for old/canceled subscription (newer subscription exists)", {
        oldSubscriptionId: subscription.id,
        currentSubscriptionId: existingDbSub.stripe_subscription_id,
        telegramUserId: telegram_user_id,
      });
      return;
    }
  }

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
    // Start containers for pending/stopped assistants asynchronously.
    // Budget is NOT synced here — only on invoice.paid to prevent timing exploits.
    try {
      const user = await getUserByTelegramId(Number(telegram_user_id));
      if (user) {
        const assistants = await listAssistantsByOwnerTelegramId(
          Number(telegram_user_id),
        );
        const toStart = assistants.filter(
          (a) =>
            a.container_status === "pending" ||
            a.container_status === "stopped",
        );

        if (toStart.length > 0) {
          const listStr = toStart
            .map((a) => {
              const u = a.assistant_bot_username ?? `#${a.id}`;
              return u.startsWith("#") ? u : `@${u}`;
            })
            .join(", ");
          await sendTelegramMessage(
            Number(telegram_user_id),
            `⏳ <b>Creating container(s)</b>\n\n${listStr}\n\nStarting up, please wait. We'll notify you when ready.`,
          );

          // Fire-and-forget: create containers in background
          void (async () => {
            const results: { label: string; ok: boolean }[] = [];
            for (const assistant of toStart) {
              const label = assistant.assistant_bot_username ?? `#${assistant.id}`;
              const displayLabel = label.startsWith("#") ? label : `@${label}`;
              try {
                await ensureAssistantContainer(assistant, user.gateway_token);
                results.push({ label: displayLabel, ok: true });
                console.log(
                  `Started container for assistant ${assistant.id} after subscription sync`,
                );
              } catch (error: unknown) {
                results.push({ label: displayLabel, ok: false });
                console.error(
                  `Failed to start container for assistant ${assistant.id}`,
                  {
                    assistantId: assistant.id,
                    error: error instanceof Error ? error.message : String(error),
                  },
                );
              }
            }
            const succeeded = results.filter((r) => r.ok).map((r) => r.label);
            const failed = results.filter((r) => !r.ok).map((r) => r.label);
            const parts: string[] = [];
            if (succeeded.length > 0) {
              parts.push(
                `✅ <b>Container(s) ready</b>\n\n${succeeded.join(", ")}\n\nYou can open the Gateway link from the guide bot to start chatting.`,
              );
            }
            if (failed.length > 0) {
              parts.push(
                `❌ <b>Creation failed</b>\n\n${failed.join(", ")}\n\nPlease contact support.`,
              );
            }
            if (parts.length > 0) {
              await sendTelegramMessage(Number(telegram_user_id), parts.join("\n\n"));
            }
          })();
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

  // Inactive subscription — only zero out budget if this is the user's current subscription.
  // During upgrade, the old subscription is canceled before the new one is created;
  // we must not zero the budget if the DB already points to a different subscription.
  const currentDbSub = await db.getSubscriptionByTelegramId(telegram_user_id);
  const isCurrentSubscription =
    !currentDbSub ||
    !currentDbSub.stripe_subscription_id ||
    currentDbSub.stripe_subscription_id === subscription.id;

  if (isCurrentSubscription) {
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
  } else {
    console.log("Skipping budget zeroing for old subscription (user has newer subscription)", {
      oldSubscriptionId: subscription.id,
      currentSubscriptionId: currentDbSub.stripe_subscription_id,
      telegramUserId: telegram_user_id,
    });
  }
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

  // invoice.paid is the ONLY trigger for resetting spend and updating budget.
  // This ensures credits are only granted after confirmed payment.
  console.log("[payment] invoice.paid: resetting spend and syncing budget", {
    invoiceId: invoice.id,
    telegramUserId: subscription.telegram_user_id,
    planCode,
  });

  await syncLiteLLMBudgetFromPlan({
    telegram_user_id: subscription.telegram_user_id,
    telegram_username: subscription.telegram_username,
    plan_code: planCode,
    source: "stripe_invoice_paid",
    reset_spend: true,
  });
}
