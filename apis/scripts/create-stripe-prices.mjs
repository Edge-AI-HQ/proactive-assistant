#!/usr/bin/env node
/**
 * 在 Stripe Test 模式下创建 Basic / Pro / Max 三个订阅价格，并写入数据库 billing_plans。
 * 价格 ID 存库后，应用从 DB 读取，无需再配置 STRIPE_PRICE_ID_* 环境变量。
 *
 * 用法（在 apis 目录下）:
 *   STRIPE_SECRET_KEY=sk_test_xxx SUPABASE_DB_URL=postgresql://... node scripts/create-stripe-prices.mjs
 */

import Stripe from 'stripe';
import pg from 'pg';

const { Pool } = pg;

const PLANS = [
  { code: 'basic', name: 'PIN AI Basic', amountCents: 499, interval: 'month' },
  { code: 'pro', name: 'PIN AI Pro', amountCents: 999, interval: 'month' },
  { code: 'max', name: 'PIN AI Max', amountCents: 1999, interval: 'month' }
];

const key = (process.env.STRIPE_SECRET_KEY || '').trim();
if (!key) {
  console.error('请设置环境变量 STRIPE_SECRET_KEY（Test 密钥 sk_test_...）');
  process.exit(1);
}
if (!key.startsWith('sk_test_')) {
  console.error('警告：当前密钥不是 sk_test_ 开头，请确认在 Test 模式下运行');
}

const dbUrl = (process.env.SUPABASE_DB_URL || '').trim();
if (!dbUrl) {
  console.error('请设置环境变量 SUPABASE_DB_URL');
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: '2023-10-16' });

async function main() {
  const out = {};
  for (const plan of PLANS) {
    const product = await stripe.products.create({
      name: plan.name,
      description: `Subscription plan: ${plan.name}`
    });
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: plan.amountCents,
      recurring: { interval: plan.interval }
    });
    out[plan.code] = { priceId: price.id, amountCents: plan.amountCents };
    console.log(`${plan.code.toUpperCase()}: ${price.id} ($${(plan.amountCents / 100).toFixed(2)}/${plan.interval})`);
  }

  const pool = new Pool({ connectionString: dbUrl });
  try {
    for (const plan of PLANS) {
      const { priceId, amountCents } = out[plan.code];
      await pool.query(
        `UPDATE billing_plans
         SET stripe_price_id = $1, price_cents_monthly = $2, updated_at = NOW()
         WHERE plan_code = $3`,
        [priceId, amountCents, plan.code]
      );
      console.log(`DB: billing_plans.${plan.code} -> stripe_price_id=${priceId}, price_cents_monthly=${amountCents}`);
    }
    console.log('\n已写入数据库。应用从 billing_plans 读取 price ID，无需再配置 STRIPE_PRICE_ID_* 环境变量。');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
