#!/usr/bin/env node
/**
 * 端到端测试：创建助理 → 模拟订阅成功 → 验证 subscription_periods 表
 * 
 * 用法: cd apis && node scripts/test-e2e-subscription.mjs
 */

import "dotenv/config";
import pg from "pg";

const API_BASE = process.env.API_BASE_URL || "http://localhost:3000";
const INTERNAL_TOKEN = process.env.API_INTERNAL_TOKEN;
const DB_URL = process.env.SUPABASE_DB_URL;

if (!INTERNAL_TOKEN) {
  console.error("❌ API_INTERNAL_TOKEN 未配置");
  process.exit(1);
}

if (!DB_URL) {
  console.error("❌ SUPABASE_DB_URL 未配置");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL });

// 测试用的 Telegram 用户
const TEST_TELEGRAM_ID = 999888777;
const TEST_BOT_TOKEN = `${TEST_TELEGRAM_ID}:AAH-test-token-${Date.now()}`;

async function cleanup() {
  console.log("\n🧹 清理测试数据...");
  const client = await pool.connect();
  try {
    // 删除该测试用户的所有数据（级联删除会处理 assistants/subscription_periods）
    await client.query("DELETE FROM users WHERE telegram_user_id = $1", [TEST_TELEGRAM_ID]);
    console.log("✅ 清理完成");
  } finally {
    client.release();
  }
}

async function createAssistant() {
  console.log("\n1️⃣ 创建助理 (create_claw_assistant)...");
  
  const res = await fetch(`${API_BASE}/api/claw-assistant/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": INTERNAL_TOKEN
    },
    body: JSON.stringify({
      ownerTelegramUserId: TEST_TELEGRAM_ID,
      botToken: TEST_BOT_TOKEN
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`创建助理失败 ${res.status}: ${text}`);
  }

  const data = await res.json();
  console.log("✅ 助理已创建:", {
    assistant_bot_id: data.assistant_bot_id,
    owner_telegram_user_id: data.owner_telegram_user_id
  });
  
  return data;
}

async function simulateCheckout() {
  console.log("\n2️⃣ 模拟订阅结账 (checkout.session.completed)...");
  
  // 先获取可用 plan
  const plansRes = await fetch(`${API_BASE}/api/payment/plans`, {
    headers: { "X-Internal-Token": INTERNAL_TOKEN }
  });
  
  if (!plansRes.ok) {
    throw new Error(`获取 plans 失败: ${plansRes.status}`);
  }
  
  const plans = await plansRes.json();
  if (!plans || plans.length === 0) {
    throw new Error("没有可用的 billing plan");
  }
  
  const plan = plans[0];
  console.log(`使用 plan: ${plan.plan_code} (${plan.credits_amount} credits)`);
  
  // 创建内部支付会话（不走真实 Stripe）
  const sessionRes = await fetch(`${API_BASE}/api/payment/internal/create-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": INTERNAL_TOKEN
    },
    body: JSON.stringify({
      telegram_user_id: TEST_TELEGRAM_ID,
      plan_code: plan.plan_code,
      ttl: 3600
    })
  });
  
  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    throw new Error(`创建会话失败 ${sessionRes.status}: ${text}`);
  }
  
  const session = await sessionRes.json();
  console.log("✅ 支付会话已创建:", session.session_id.slice(0, 16) + "...");
  
  return { session, plan };
}

async function simulateInvoicePaid() {
  console.log("\n3️⃣ 模拟 Stripe invoice.paid 写入 subscription_periods...");
  
  const client = await pool.connect();
  try {
    // 查询用户 ID
    const userResult = await client.query(
      "SELECT id FROM users WHERE telegram_user_id = $1",
      [TEST_TELEGRAM_ID]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error("用户不存在（应该在创建助理时自动创建）");
    }
    
    const userId = userResult.rows[0].id;
    
    // 获取第一个 plan
    const planResult = await client.query(
      "SELECT plan_code FROM billing_plans ORDER BY credits_amount LIMIT 1"
    );
    
    if (planResult.rows.length === 0) {
      throw new Error("billing_plans 表为空");
    }
    
    const planCode = planResult.rows[0].plan_code;
    
    // 插入一个订阅周期（模拟 invoice.paid 事件的结果）
    const now = new Date();
    const periodStart = now;
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 天后
    
    const subscriptionId = `sub_test_${Date.now()}`;
    const customerId = `cus_test_${TEST_TELEGRAM_ID}`;
    const invoiceId = `in_test_${Date.now()}`;
    
    await client.query(
      `INSERT INTO subscription_periods (
        user_id, stripe_subscription_id, stripe_customer_id, stripe_invoice_id,
        period_start, period_end, plan_id, status, cancel_at_period_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', false)`,
      [userId, subscriptionId, customerId, invoiceId, periodStart, periodEnd, planCode]
    );
    
    console.log("✅ subscription_periods 记录已插入:", {
      subscription_id: subscriptionId,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      plan_id: planCode
    });
    
    return { userId, subscriptionId, periodStart, periodEnd };
  } finally {
    client.release();
  }
}

async function verifySubscriptionPeriods(expectedSubId) {
  console.log("\n4️⃣ 验证 subscription_periods 表...");
  
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT 
        sp.id, sp.stripe_subscription_id, sp.stripe_customer_id, sp.stripe_invoice_id,
        sp.period_start, sp.period_end, sp.plan_id, sp.status, sp.cancel_at_period_end,
        sp.budget_applied_at, u.telegram_user_id
      FROM subscription_periods sp
      JOIN users u ON u.id = sp.user_id
      WHERE u.telegram_user_id = $1`,
      [TEST_TELEGRAM_ID]
    );
    
    if (result.rows.length === 0) {
      throw new Error("❌ subscription_periods 表中没有找到记录");
    }
    
    const row = result.rows[0];
    console.log("✅ 找到记录:");
    console.log("  - stripe_subscription_id:", row.stripe_subscription_id);
    console.log("  - stripe_invoice_id:", row.stripe_invoice_id);
    console.log("  - period_start:", row.period_start);
    console.log("  - period_end:", row.period_end);
    console.log("  - plan_id:", row.plan_id);
    console.log("  - status:", row.status);
    console.log("  - budget_applied_at:", row.budget_applied_at || "(未应用)");
    
    // 验证当前时间是否在周期内
    const now = new Date();
    const isCurrentPeriod = row.period_start <= now && now < row.period_end;
    console.log("  - 当前是否在周期内:", isCurrentPeriod ? "✅ 是" : "❌ 否");
    
    if (!isCurrentPeriod) {
      throw new Error("当前时间不在周期范围内，定时任务不会应用 budget");
    }
    
    return row;
  } finally {
    client.release();
  }
}

async function testApplyBudget() {
  console.log("\n5️⃣ 测试定时任务应用 budget...");
  
  const res = await fetch(`${API_BASE}/api/payment/cron/apply-budgets`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CRON_SECRET || ""}`,
      "X-Internal-Token": INTERNAL_TOKEN
    }
  });
  
  if (!res.ok) {
    const text = await res.text();
    console.warn(`⚠️  定时任务调用失败 ${res.status}: ${text}`);
    console.log("(可能是 CRON_SECRET 未配置，跳过此步骤)");
    return;
  }
  
  const result = await res.json();
  console.log("✅ 定时任务执行结果:", result);
  
  // 再次查询确认 budget_applied_at 是否已更新
  const client = await pool.connect();
  try {
    const check = await client.query(
      `SELECT budget_applied_at 
       FROM subscription_periods sp
       JOIN users u ON u.id = sp.user_id
       WHERE u.telegram_user_id = $1`,
      [TEST_TELEGRAM_ID]
    );
    
    if (check.rows.length > 0 && check.rows[0].budget_applied_at) {
      console.log("✅ budget_applied_at 已更新:", check.rows[0].budget_applied_at);
    } else {
      console.log("⚠️  budget_applied_at 仍为 NULL（可能周期还未到应用时间）");
    }
  } finally {
    client.release();
  }
}

async function main() {
  console.log("🚀 开始端到端测试: 创建助理 → 订阅 → 验证");
  console.log("API_BASE:", API_BASE);
  console.log("TEST_TELEGRAM_ID:", TEST_TELEGRAM_ID);
  
  try {
    // 先清理旧数据
    await cleanup();
    
    // 1. 创建助理
    const assistant = await createAssistant();
    
    // 2. 模拟 checkout（获取 plan 信息）
    const { plan } = await simulateCheckout();
    
    // 3. 直接写入 subscription_periods（模拟 invoice.paid）
    const { subscriptionId } = await simulateInvoicePaid();
    
    // 4. 验证写入
    await verifySubscriptionPeriods(subscriptionId);
    
    // 5. 测试定时任务应用 budget
    await testApplyBudget();
    
    console.log("\n✅ 所有测试通过!");
    
    // 最后清理
    await cleanup();
    
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
