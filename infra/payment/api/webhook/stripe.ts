import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { db } from '../../lib/db.js';

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

const nextBillingText = (date: Date): string =>
  date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    });
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const telegram_user_id = session.metadata?.telegram_user_id?.trim();
  const payment_token = session.metadata?.payment_token;
  const plan = session.metadata?.plan;

  if (!telegram_user_id) {
    throw new Error('checkout.session.completed missing metadata.telegram_user_id');
  }

  console.log(`Checkout completed for user ${telegram_user_id}`);

  await db.upsertUserSubscription({
    telegram_user_id,
    telegram_username: session.metadata?.telegram_username,
    stripe_customer_id: session.customer as string,
    stripe_subscription_id: session.subscription as string,
    plan_id: typeof plan === 'string' ? plan : undefined
  });

  if (payment_token) {
    await db.markPaymentSessionUsed(payment_token);
    console.log(`Token ${payment_token.substring(0, 10)}... marked as used`);
  }

  await sendTelegramMessage(
    telegram_user_id,
    '✅ Payment successful!\n\n🚀 We are creating your OpenClaw container now...\n\nYou will receive another message when it is ready.'
  );
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

  await db.upsertUserSubscription({
    telegram_user_id,
    telegram_username: subscription.metadata?.telegram_username,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    plan_id: typeof subscription.metadata?.plan === 'string' ? subscription.metadata.plan : undefined
  });

  await db.updateSubscriptionStatus(
    telegram_user_id,
    status,
    periodStart,
    periodEnd,
    Boolean(subscription.cancel_at_period_end)
  );

  if (status === 'active') {
    await sendTelegramMessage(
      telegram_user_id,
      `🎉 Your OpenClaw container is ready!\n\n📦 Container Status: Active\n📅 Next billing: ${nextBillingText(periodEnd)}`
    );
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

  console.log('Received Stripe event:', event.type);

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

      default:
        console.log(`Unhandled event type: ${event.type}`);
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
