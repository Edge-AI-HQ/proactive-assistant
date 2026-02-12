import Stripe from 'stripe';
import { db } from './supabase';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-11-20.acacia',
});

export const stripeService = {
  // 创建或获取 Stripe 客户
  async getOrCreateCustomer(
    telegram_user_id: string,
    telegram_username?: string,
    email?: string
  ): Promise<string> {
    // 先查询数据库是否已有客户
    const subscription = await db.getSubscriptionByTelegramId(telegram_user_id);
    if (subscription?.stripe_customer_id) {
      return subscription.stripe_customer_id;
    }

    // 创建新客户
    const customer = await stripe.customers.create({
      email,
      metadata: {
        telegram_user_id,
        telegram_username: telegram_username || '',
      },
    });

    // 保存到数据库
    await db.upsertUserSubscription({
      telegram_user_id,
      telegram_username,
      stripe_customer_id: customer.id,
    });

    return customer.id;
  },

  // 创建订阅 Checkout Session
  async createCheckoutSession(
    telegram_user_id: string,
    telegram_username?: string,
    email?: string
  ): Promise<string> {
    const customerId = await this.getOrCreateCustomer(
      telegram_user_id,
      telegram_username,
      email
    );

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID!,
          quantity: 1,
        },
      ],
      success_url: `${process.env.TELEGRAM_WEBHOOK_DOMAIN}/api/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.TELEGRAM_WEBHOOK_DOMAIN}/api/cancel`,
      metadata: {
        telegram_user_id,
        telegram_username: telegram_username || '',
      },
      subscription_data: {
        metadata: {
          telegram_user_id,
          telegram_username: telegram_username || '',
        },
      },
    });

    return session.url!;
  },

  // 创建客户门户会话（用户管理订阅）
  async createPortalSession(stripe_customer_id: string): Promise<string> {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripe_customer_id,
      return_url: `${process.env.TELEGRAM_WEBHOOK_DOMAIN}/`,
    });

    return session.url;
  },

  // 取消订阅
  async cancelSubscription(stripe_subscription_id: string): Promise<void> {
    await stripe.subscriptions.cancel(stripe_subscription_id);
  },

  // 获取订阅详情
  async getSubscription(
    stripe_subscription_id: string
  ): Promise<Stripe.Subscription> {
    return await stripe.subscriptions.retrieve(stripe_subscription_id);
  },

  // 验证 Webhook 签名
  constructWebhookEvent(
    payload: string | Buffer,
    signature: string
  ): Stripe.Event {
    return stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  },
};
