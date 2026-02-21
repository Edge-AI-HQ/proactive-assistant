import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { db, type UserSubscription } from '../../lib/db.js';
import { reconcileWalletUsageFromLiteLLM, syncLiteLLMBudgetForWallet } from '../../lib/litellmBillingSync.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16'
});

export const config = {
  api: {
    bodyParser: false
  }
};

async function buffer(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const mapStripeSubscriptionStatus = (
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

const extractTelegramUserId = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const metadata = (payload as { metadata?: Record<string, unknown> }).metadata;
  const value = typeof metadata?.telegram_user_id === 'string' ? metadata.telegram_user_id.trim() : '';
  return value || undefined;
};

const extractAmount = (payload: unknown): number | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const candidates = [record.amount_total, record.amount_paid, record.amount_due, record.amount];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return Math.trunc(candidate);
  }
  return undefined;
};

const extractCurrency = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  return typeof record.currency === 'string' ? record.currency : undefined;
};

const extractStatus = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.status === 'string') return record.status;
  if (typeof record.payment_status === 'string') return record.payment_status;
  return undefined;
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
    const byPrice = await db.getPlanByStripePriceId(priceId);
    if (byPrice?.plan_code) return byPrice.plan_code;
  }

  return subscription?.plan_id ?? null;
};

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const telegram_user_id = session.metadata?.telegram_user_id?.trim();
  const payment_token = session.metadata?.payment_token;
  const plan = session.metadata?.plan;

  if (!telegram_user_id) {
    throw new Error('checkout.session.completed missing metadata.telegram_user_id');
  }

  await db.upsertUserSubscription({
    telegram_user_id,
    telegram_username: session.metadata?.telegram_username,
    stripe_customer_id: session.customer as string,
    stripe_subscription_id: session.subscription as string,
    plan_id: typeof plan === 'string' ? plan : undefined
  });

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

async function syncSubscriptionFromStripe(subscription: Stripe.Subscription): Promise<void> {
  const telegram_user_id = await resolveTelegramUserIdForSubscription(subscription);
  if (!telegram_user_id) {
    console.warn('Unable to resolve telegram_user_id for subscription event', subscription.id);
    return;
  }

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customerId) {
    throw new Error(`Subscription ${subscription.id} missing customer id`);
  }

  const periodStart = new Date(subscription.current_period_start * 1000);
  const periodEnd = new Date(subscription.current_period_end * 1000);
  const status = mapStripeSubscriptionStatus(subscription.status);
  const planCode = await resolvePlanCodeFromSubscription(subscription);

  await db.upsertUserSubscription({
    telegram_user_id,
    telegram_username: subscription.metadata?.telegram_username,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    plan_id: planCode ?? undefined
  });

  await db.updateSubscriptionStatus(
    telegram_user_id,
    status,
    periodStart,
    periodEnd,
    Boolean(subscription.cancel_at_period_end)
  );

  if (planCode) {
    await db.upsertWalletPlanContext({
      telegram_user_id,
      telegram_username: subscription.metadata?.telegram_username,
      plan_id: planCode,
      next_monthly_refresh_at: periodEnd
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

async function handleInvoicePaid(eventId: string, invoice: Stripe.Invoice): Promise<void> {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown signature verification error';
    console.error('Webhook signature verification failed:', message);
    return res.status(400).send(`Webhook Error: ${message}`);
  }

  const eventObject = event.data.object;
  const claim = await db.claimStripeEvent({
    telegram_user_id: extractTelegramUserId(eventObject),
    stripe_event_id: event.id,
    event_type: event.type,
    amount: extractAmount(eventObject),
    currency: extractCurrency(eventObject),
    status: extractStatus(eventObject),
    raw_data: eventObject
  });

  if (claim === 'skip') {
    return res.json({ received: true, skipped: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(eventObject as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscriptionFromStripe(eventObject as Stripe.Subscription);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(event.id, eventObject as Stripe.Invoice);
        break;

      default:
        break;
    }

    await db.markStripeEventProcessed(event.id);
    res.json({ received: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown webhook handler error';
    await db.markStripeEventFailed(event.id, message);
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: message });
  }
}
