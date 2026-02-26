#!/usr/bin/env node
/**
 * 测试订阅同步逻辑（模拟 Stripe webhook 调用 syncSubscriptionFromStripe）
 */

import Stripe from 'stripe';
import pg from 'pg';

const { Pool } = pg;

const stripeKey = process.env.STRIPE_SECRET_KEY || '';
const dbUrl = process.env.SUPABASE_DB_URL || '';

if (!stripeKey || !dbUrl) {
  console.error('请设置 STRIPE_SECRET_KEY 和 SUPABASE_DB_URL');
  process.exit(1);
}

const stripe = new Stripe(stripeKey);
const pool = new Pool({ connectionString: dbUrl });

async function main() {
  try {
    // 获取数据库中的订阅ID
    const subRes = await pool.query(
      `SELECT stripe_subscription_id FROM user_subscriptions WHERE user_id = 1 LIMIT 1`
    );
    
    if (subRes.rows.length === 0) {
      console.log('❌ 没有找到订阅');
      process.exit(1);
    }

    const subId = subRes.rows[0].stripe_subscription_id;
    console.log('📋 订阅ID:', subId);

    // 从 Stripe 获取最新订阅信息
    console.log('🔍 从 Stripe 获取订阅信息...');
    const subscription = await stripe.subscriptions.retrieve(subId);
    
    console.log('\n--- Stripe 订阅信息 ---');
    console.log('状态:', subscription.status);
    console.log('客户ID:', subscription.customer);
    console.log('周期:', new Date(subscription.current_period_start * 1000), '->', new Date(subscription.current_period_end * 1000));
    console.log('取消标记:', subscription.cancel_at_period_end);
    console.log('价格ID:', subscription.items.data[0]?.price?.id);

    // 查询价格对应的套餐
    const priceId = subscription.items.data[0]?.price?.id;
    if (priceId) {
      const planRes = await pool.query(
        'SELECT plan_code FROM billing_plans WHERE stripe_price_id = $1',
        [priceId]
      );
      console.log('套餐:', planRes.rows[0]?.plan_code || '未找到');
    }

    console.log('\n✅ 订阅信息获取成功');
    console.log('\n💡 现在需要在 Stripe Dashboard 重新发送 webhook 事件来触发同步');
    console.log('   1. 打开 https://dashboard.stripe.com/test/webhooks');
    console.log('   2. 找到你的 webhook 端点');
    console.log('   3. 点击"发送测试 webhook"');
    console.log('   4. 选择 "customer.subscription.updated"');
    console.log(`   5. 使用订阅ID: ${subId}`);
    
  } catch (error) {
    console.error('❌ 错误:', error.message);
  } finally {
    await pool.end();
  }
}

main();
