import { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-11-20.acacia',
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// 套餐配置
const PLANS = {
  basic: {
    priceId: process.env.STRIPE_PRICE_ID_BASIC || process.env.STRIPE_PRICE_ID!,
    name: 'Basic',
  },
  pro: {
    priceId: process.env.STRIPE_PRICE_ID_PRO!,
    name: 'Pro',
  },
  max: {
    priceId: process.env.STRIPE_PRICE_ID_MAX!,
    name: 'Max',
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token, plan = 'basic' } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // 验证并获取 token 信息
    const { data: session, error: sessionError } = await supabase
      .from('payment_sessions')
      .select('*')
      .eq('token', token)
      .single();

    if (sessionError || !session) {
      return res.status(404).json({ error: 'Invalid token' });
    }

    // 检查是否已使用
    if (session.used) {
      return res.status(400).json({ error: 'Token already used' });
    }

    // 检查是否过期
    if (new Date(session.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token expired' });
    }

    // 验证套餐
    if (!PLANS[plan as keyof typeof PLANS]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const selectedPlan = PLANS[plan as keyof typeof PLANS];
    const user_id = session.telegram_user_id;
    const username = session.telegram_username;

    // 检查是否已有客户
    const { data: existingSub } = await supabase
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('telegram_user_id', user_id)
      .single();

    let customerId = existingSub?.stripe_customer_id;

    // 如果有客户 ID，验证它在 Stripe 中是否存在
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
        console.log(`Using existing customer: ${customerId}`);
      } catch (error: any) {
        // 客户不存在（可能是切换了 Stripe 账户），创建新客户
        console.log(`Customer ${customerId} not found, creating new one`);
        customerId = null;
      }
    }

    // 如果没有客户或客户不存在，创建新客户
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: {
          telegram_user_id: user_id,
          telegram_username: username || '',
        },
      });

      customerId = customer.id;
      console.log(`Created new customer: ${customerId}`);

      // 更新数据库
      await supabase.from('user_subscriptions').upsert({
        telegram_user_id: user_id,
        telegram_username: username,
        stripe_customer_id: customerId,
      });
    }

    // 创建 Checkout Session
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price: selectedPlan.priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.TELEGRAM_WEBHOOK_DOMAIN}/api/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.TELEGRAM_WEBHOOK_DOMAIN}/api/subscribe?token=${token}`,
      metadata: {
        telegram_user_id: user_id,
        telegram_username: username || '',
        plan: plan,
        payment_token: token,
      },
      subscription_data: {
        metadata: {
          telegram_user_id: user_id,
          telegram_username: username || '',
          plan: plan,
        },
      },
    });

    // 注意：不在这里标记 token 为已使用
    // Token 将在支付成功后（webhook 收到 checkout.session.completed）才标记为已使用
    // 这样用户可以多次尝试支付，直到成功或 token 过期

    res.status(200).json({ url: checkoutSession.url });
  } catch (error: any) {
    console.error('Create checkout error:', error);
    res.status(500).json({ error: error.message });
  }
}
