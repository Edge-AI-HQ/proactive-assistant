import Stripe from 'stripe';
import { db, type UserSubscription } from './db.js';
import { reconcileWalletUsageFromLiteLLM, syncLiteLLMBudgetForWallet } from './litellmBillingSync.js';
import { resolvePlanCodeFromStripePriceId } from './planCatalog.js';

export const mapStripeSubscriptionStatus = (
  status: Stripe.Subscription.Status
): 'active' | 'paused' | 'canceled' | 'pending' => {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'canceled':
    case 'incomplete_expired':
    case 'unpaid':
      return 'canceled';
    case 'past_due':
    case 'paused':
      return 'paused';
    case 'incomplete':
    default:
      return 'pending';
  }
};

const parseUnixSecondsToDate = (value: unknown): Date | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const parsed = new Date(value * 1000);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
};

const readSubscriptionPriceId = (subscription: Stripe.Subscription): string | null => {
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

const readInvoicePeriodEnd = (invoice: Stripe.Invoice): Date | null => {
  let latestEnd = 0;
  for (const line of invoice.lines.data) {
    const end = line.period?.end;
    if (typeof end === 'number' && Number.isFinite(end) && end > latestEnd) {
      latestEnd = end;
    }
  }

  if (latestEnd > 0) {
    return new Date(latestEnd * 1000);
  }

  const fallback = invoice.period_end;
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return new Date(fallback * 1000);
  }

  return null;
};

const resolvePlanCodeFromSubscription = async (subscription: Stripe.Subscription): Promise<string | null> => {
  const fromMetadata = subscription.metadata?.plan?.trim();
  if (fromMetadata) return fromMetadata;

  const priceId = readSubscriptionPriceId(subscription);
  if (!priceId) return null;

  const fromConfiguredPrice = resolvePlanCodeFromStripePriceId(priceId);
  if (fromConfiguredPrice) return fromConfiguredPrice;

  const plan = await db.getPlanByStripePriceId(priceId);
  return plan?.plan_code ?? null;
};

const resolvePlanCodeFromInvoice = async (
  invoice: Stripe.Invoice,
  subscription: UserSubscription | null
): Promise<string | null> => {
  const fromMetadata = invoice.metadata?.plan?.trim();
  if (fromMetadata) return fromMetadata;

  const priceId = readInvoicePriceId(invoice);
  if (priceId) {
    const fromConfiguredPrice = resolvePlanCodeFromStripePriceId(priceId);
    if (fromConfiguredPrice) return fromConfiguredPrice;

    const byPrice = await db.getPlanByStripePriceId(priceId);
    if (byPrice?.plan_code) return byPrice.plan_code;
  }

  return subscription?.plan_id ?? null;
};

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const telegram_user_id = session.metadata?.telegram_user_id?.trim();
  const payment_token = session.metadata?.payment_token;
  const plan = session.metadata?.plan;

  if (!telegram_user_id) {
    throw new Error('checkout.session.completed missing metadata.telegram_user_id');
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
    stripe_subscription_id: session.subscription as string
  };

  const username = session.metadata?.telegram_username;
  if (typeof username === 'string' && username.trim()) payload.telegram_username = username.trim();
  if (typeof plan === 'string' && plan.trim()) payload.plan_id = plan.trim();

  await db.upsertUserSubscription(payload);

  if (payment_token) {
    await db.markPaymentSessionUsed(payment_token);
  }
}

async function resolveTelegramUserIdForSubscription(subscription: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = subscription.metadata?.telegram_user_id?.trim();
  if (fromMetadata) return fromMetadata;

  const bySubId = await db.getSubscriptionByStripeSubscriptionId(subscription.id);
  if (bySubId?.telegram_user_id) return bySubId.telegram_user_id;

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
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
  }
): Promise<void> {
  const telegram_user_id = await resolveTelegramUserIdForSubscription(subscription);
  if (!telegram_user_id) {
    console.warn('Unable to resolve telegram_user_id for subscription event', subscription.id);
    return;
  }

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customerId) {
    throw new Error(`Subscription ${subscription.id} missing customer id`);
  }

  const periodStart = parseUnixSecondsToDate(subscription.current_period_start);
  const periodEnd = parseUnixSecondsToDate(subscription.current_period_end);
  const status = mapStripeSubscriptionStatus(subscription.status);
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
    stripe_subscription_id: subscription.id
  };
  const username = subscription.metadata?.telegram_username;
  if (typeof username === 'string' && username.trim()) payload.telegram_username = username.trim();
  if (planCode) payload.plan_id = planCode;

  await db.upsertUserSubscription(payload);

  const applied = await db.updateSubscriptionStatus(
    telegram_user_id,
    status,
    periodStart ?? undefined,
    periodEnd ?? undefined,
    typeof subscription.cancel_at_period_end === 'boolean' ? subscription.cancel_at_period_end : undefined,
    eventContext?.event_created,
    eventContext?.event_id
  );
  if (!applied) {
    console.warn('Skipping stale subscription update event', {
      subscriptionId: subscription.id,
      telegramUserId: telegram_user_id,
      eventId: eventContext?.event_id,
      eventCreated: eventContext?.event_created
    });
    return;
  }

  if (planCode && periodEnd) {
    const walletPlanPayload: {
      telegram_user_id: string;
      plan_id: string;
      next_monthly_refresh_at: Date;
      telegram_username?: string | null;
    } = {
      telegram_user_id,
      plan_id: planCode,
      next_monthly_refresh_at: periodEnd
    };
    const username = subscription.metadata?.telegram_username;
    if (typeof username === 'string') walletPlanPayload.telegram_username = username.trim() || null;
    await db.upsertWalletPlanContext(walletPlanPayload);
  } else if (planCode && !periodEnd) {
    console.warn('Skipping wallet plan context update due to missing period end', {
      subscriptionId: subscription.id,
      telegramUserId: telegram_user_id,
      status: subscription.status
    });
  }
}

const resolveSubscriptionFromInvoice = async (invoice: Stripe.Invoice): Promise<UserSubscription | null> => {
  const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  if (subscriptionId) {
    const bySub = await db.getSubscriptionByStripeSubscriptionId(subscriptionId);
    if (bySub) return bySub;
  }

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
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

export async function handleInvoicePaid(eventId: string, invoice: Stripe.Invoice): Promise<void> {
  const subscription = await resolveSubscriptionFromInvoice(invoice);
  if (!subscription?.telegram_user_id) {
    console.warn('invoice.paid could not resolve subscription user', invoice.id || eventId);
    return;
  }

  const planCode = await resolvePlanCodeFromInvoice(invoice, subscription);
  if (!planCode) {
    console.warn('invoice.paid missing plan code', {
      invoiceId: invoice.id,
      subscriptionId: subscription.stripe_subscription_id,
      telegramUserId: subscription.telegram_user_id
    });
    return;
  }

  const periodEnd = readInvoicePeriodEnd(invoice) ?? (subscription.current_period_end ? new Date(subscription.current_period_end) : null);
  if (!periodEnd || Number.isNaN(periodEnd.getTime())) {
    console.warn('invoice.paid missing period end', invoice.id || eventId);
    return;
  }

  await reconcileWalletUsageFromLiteLLM({
    user_id: subscription.user_id,
    telegram_user_id: subscription.telegram_user_id,
    source: 'stripe_webhook',
    marker: invoice.id || eventId
  });

  const refresh = await db.applyMonthlyCreditsRefresh({
    telegram_user_id: subscription.telegram_user_id,
    telegram_username: subscription.telegram_username,
    plan_id: planCode,
    next_monthly_refresh_at: periodEnd,
    idempotency_key: `invoice_paid:${invoice.id || eventId}`,
    source: 'stripe_webhook',
    metadata: {
      stripe_event_id: eventId,
      stripe_invoice_id: invoice.id || null,
      plan_code: planCode
    }
  });

  if (refresh.wallet) {
    await syncLiteLLMBudgetForWallet(refresh.wallet);
  }
}
