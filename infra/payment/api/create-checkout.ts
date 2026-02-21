import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { db } from '../lib/db.js';
import { readPaymentPublicBaseUrl } from '../lib/publicBaseUrl.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16'
});

type CheckoutBody = {
  token?: string;
  plan?: string;
};

const normalizePlanCode = (value: string | undefined): string => {
  const trimmed = (value || '').trim().toLowerCase();
  return trimmed || 'basic';
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = (req.body || {}) as CheckoutBody;
    const token = String(body.token || '').trim();
    const planCode = normalizePlanCode(body.plan);
    const landingBaseUrl = readPaymentPublicBaseUrl(req);

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const session = await db.getPaymentSessionByToken(token);
    if (!session) {
      return res.status(404).json({ error: 'Invalid token' });
    }

    if (session.used) {
      return res.status(400).json({ error: 'Token already used' });
    }

    if (new Date(session.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token expired' });
    }

    const selectedPlan = await db.getPlanByCode(planCode);
    if (!selectedPlan || !selectedPlan.is_active) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const telegramUserId = session.telegram_user_id;
    const telegramUsername = session.telegram_username;

    const existingSub = await db.getSubscriptionByTelegramId(telegramUserId);
    let customerId = existingSub?.stripe_customer_id ?? null;

    if (customerId) {
      try {
        const customer = await stripe.customers.retrieve(customerId);
        if ('deleted' in customer && customer.deleted) {
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
          telegram_username: telegramUsername || ''
        }
      });

      customerId = customer.id;
      await db.upsertUserSubscription({
        telegram_user_id: telegramUserId,
        telegram_username: telegramUsername ?? undefined,
        stripe_customer_id: customerId,
        plan_id: selectedPlan.plan_code
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price: selectedPlan.stripe_price_id,
          quantity: 1
        }
      ],
      success_url: `${landingBaseUrl}/api/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${landingBaseUrl}/api/subscribe?token=${token}`,
      metadata: {
        telegram_user_id: telegramUserId,
        telegram_username: telegramUsername || '',
        plan: selectedPlan.plan_code,
        payment_token: token
      },
      subscription_data: {
        metadata: {
          telegram_user_id: telegramUserId,
          telegram_username: telegramUsername || '',
          plan: selectedPlan.plan_code
        }
      }
    });

    res.status(200).json({ url: checkoutSession.url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Create checkout error:', error);
    res.status(500).json({ error: message });
  }
}
