import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { db } from '../../lib/db.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Received Stripe event:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object as Stripe.Subscription);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // 记录事件到数据库
    await db.logPaymentEvent({
      telegram_user_id: (event.data.object as { metadata?: { telegram_user_id?: string } }).metadata?.telegram_user_id,
      stripe_event_id: event.id,
      event_type: event.type,
      raw_data: event.data.object
    });

    res.json({ received: true });
  } catch (error: any) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: error.message });
  }
}

// 处理 Checkout 完成
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const telegram_user_id = session.metadata?.telegram_user_id;
  const payment_token = session.metadata?.payment_token;

  if (!telegram_user_id) return;

  console.log(`Checkout completed for user ${telegram_user_id}`);

  // 更新用户订阅
  await db.upsertUserSubscription({
    telegram_user_id,
    telegram_username: session.metadata?.telegram_username,
    stripe_customer_id: session.customer as string,
    stripe_subscription_id: session.subscription as string
  });

  // 标记 token 为已使用（支付成功后才标记）
  if (payment_token) {
    await db.markPaymentSessionUsed(payment_token);

    console.log(`Token ${payment_token.substring(0, 10)}... marked as used`);
  }

  // 发送 Telegram 通知
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegram_user_id,
        text: `✅ Payment successful!\n\n🚀 We're creating your OpenClaw container now...\n\nYou'll receive another message when it's ready.`,
      }),
    });
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
  }
}

// 处理订阅创建
async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  const telegram_user_id = subscription.metadata?.telegram_user_id;
  if (!telegram_user_id) return;

  console.log(`Subscription created for user ${telegram_user_id}`);

  const periodStart = new Date(subscription.current_period_start * 1000);
  const periodEnd = new Date(subscription.current_period_end * 1000);

  // 更新订阅状态
  await db.updateSubscriptionStatus(telegram_user_id, 'active', periodStart, periodEnd);

  console.log(`Subscription activated for user ${telegram_user_id}`);

  // 发送容器创建完成通知
  try {
    const nextBillingDate = periodEnd.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegram_user_id,
        text: `🎉 Your OpenClaw container is ready!\n\n📦 Container Status: Active\n📅 Next billing: ${nextBillingDate}\n\n🔗 Access your container soon (Docker integration coming)`,
      }),
    });
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
  }
}
