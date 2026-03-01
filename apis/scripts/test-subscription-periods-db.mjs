#!/usr/bin/env node
/**
 * 数据库级别测试：验证 subscription_periods 表逻辑
 * 不依赖 HTTP server，直接测 DB 和核心函数
 */

import "dotenv/config";
import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error("❌ SUPABASE_DB_URL 未配置");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL });
const TEST_TELEGRAM_ID = 999888777;

async function cleanup() {
  console.log("🧹 清理测试数据...");
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM users WHERE telegram_user_id = $1", [TEST_TELEGRAM_ID]);
    console.log("✅ 清理完成\n");
  } finally {
    client.release();
  }
}

async function testUserCreation() {
  console.log("1️⃣ 测试创建用户...");
  const client = await pool.connect();
  try {
    // gateway_token 是必填字段，生成一个随机 token
    const gatewayToken = `gw_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = await client.query(
      `INSERT INTO users (telegram_user_id, telegram_username, gateway_token)
       VALUES ($1, $2, $3)
       RETURNING id, telegram_user_id`,
      [TEST_TELEGRAM_ID, "test_user", gatewayToken]
    );
    
    const user = result.rows[0];
    console.log(`✅ 用户已创建: id=${user.id}, telegram_user_id=${user.telegram_user_id}\n`);
    return user.id;
  } finally {
    client.release();
  }
}

async function testSubscriptionPeriodInsert(userId) {
  console.log("2️⃣ 测试插入 subscription_periods...");
  const client = await pool.connect();
  try {
    // 先获取一个有效的 plan_code
    const planResult = await client.query(
      "SELECT plan_code FROM billing_plans ORDER BY monthly_refresh_credits DESC LIMIT 1"
    );
    
    if (planResult.rows.length === 0) {
      throw new Error("billing_plans 表为空，无法测试");
    }
    
    const planCode = planResult.rows[0].plan_code;
    
    const now = new Date();
    const periodStart = new Date(now.getTime() - 1000); // 1秒前开始（已进入）
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30天后
    
    const subscriptionId = `sub_test_${Date.now()}`;
    const customerId = `cus_test_${TEST_TELEGRAM_ID}`;
    const invoiceId = `in_test_${Date.now()}`;
    
    const result = await client.query(
      `INSERT INTO subscription_periods (
        user_id, stripe_subscription_id, stripe_customer_id, stripe_invoice_id,
        period_start, period_end, plan_id, status, cancel_at_period_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', false)
      RETURNING id, stripe_subscription_id, period_start, period_end`,
      [userId, subscriptionId, customerId, invoiceId, periodStart, periodEnd, planCode]
    );
    
    const period = result.rows[0];
    console.log("✅ 周期已插入:");
    console.log(`   id: ${period.id}`);
    console.log(`   subscription_id: ${period.stripe_subscription_id}`);
    console.log(`   period_start: ${period.period_start}`);
    console.log(`   period_end: ${period.period_end}\n`);
    
    return { periodId: period.id, subscriptionId };
  } finally {
    client.release();
  }
}

async function testCurrentPeriodQuery(userId) {
  console.log("3️⃣ 测试查询当前生效周期...");
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT 
        id, stripe_subscription_id, period_start, period_end, plan_id, 
        status, budget_applied_at
      FROM subscription_periods
      WHERE user_id = $1
        AND period_start <= NOW()
        AND period_end > NOW()
      ORDER BY period_start DESC
      LIMIT 1`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      throw new Error("❌ 查询当前周期失败（应该能找到刚插入的周期）");
    }
    
    const period = result.rows[0];
    console.log("✅ 找到当前生效周期:");
    console.log(`   subscription_id: ${period.stripe_subscription_id}`);
    console.log(`   plan_id: ${period.plan_id}`);
    console.log(`   status: ${period.status}`);
    console.log(`   budget_applied_at: ${period.budget_applied_at || "(未应用)"}\n`);
    
    return period;
  } finally {
    client.release();
  }
}

async function testPeriodsToApplyBudget() {
  console.log("4️⃣ 测试查询「需要应用 budget」的周期...");
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT 
        sp.id, sp.stripe_subscription_id, sp.plan_id,
        u.telegram_user_id, u.telegram_username
      FROM subscription_periods sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.budget_applied_at IS NULL
        AND sp.period_start <= NOW()
        AND sp.period_end > NOW()
      ORDER BY sp.period_start ASC`
    );
    
    console.log(`✅ 找到 ${result.rows.length} 个需要应用 budget 的周期`);
    
    result.rows.forEach((row, idx) => {
      console.log(`   [${idx + 1}] telegram_user_id=${row.telegram_user_id}, plan=${row.plan_id}, sub=${row.stripe_subscription_id}`);
    });
    
    console.log();
    return result.rows;
  } finally {
    client.release();
  }
}

async function testMarkBudgetApplied(periodId) {
  console.log("5️⃣ 测试标记 budget 已应用...");
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE subscription_periods
       SET budget_applied_at = NOW()
       WHERE id = $1`,
      [periodId]
    );
    
    const check = await client.query(
      "SELECT budget_applied_at FROM subscription_periods WHERE id = $1",
      [periodId]
    );
    
    console.log(`✅ budget_applied_at 已更新: ${check.rows[0].budget_applied_at}\n`);
  } finally {
    client.release();
  }
}

async function testEndedSubscriptions() {
  console.log("6️⃣ 测试查询「已结束订阅」的用户...");
  const client = await pool.connect();
  try {
    // 查询：曾经有周期，但当前时间没有生效周期的用户
    const result = await client.query(
      `SELECT DISTINCT u.telegram_user_id, u.telegram_username
       FROM users u
       WHERE EXISTS (
         SELECT 1 FROM subscription_periods sp WHERE sp.user_id = u.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM subscription_periods sp
         WHERE sp.user_id = u.id
           AND sp.period_start <= NOW()
           AND sp.period_end > NOW()
       )`
    );
    
    console.log(`✅ 找到 ${result.rows.length} 个已结束订阅的用户`);
    console.log("   (当前测试用户应该不在此列表，因为周期仍在有效期)\n");
    
    return result.rows;
  } finally {
    client.release();
  }
}

async function testIndexes() {
  console.log("7️⃣ 验证索引存在...");
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT indexname FROM pg_indexes 
       WHERE tablename = 'subscription_periods'
       ORDER BY indexname`
    );
    
    const expectedIndexes = [
      "subscription_periods_pkey",
      "subscription_periods_unique_sub_period",
      "idx_subscription_periods_stripe_invoice_id",
      "idx_subscription_periods_stripe_customer_id",
      "idx_subscription_periods_apply_budget",
      "idx_subscription_periods_user_period"
    ];
    
    const actual = result.rows.map(r => r.indexname);
    const missing = expectedIndexes.filter(idx => !actual.includes(idx));
    
    if (missing.length > 0) {
      throw new Error(`❌ 缺失索引: ${missing.join(", ")}`);
    }
    
    console.log("✅ 所有 6 个索引都存在:");
    actual.forEach(idx => console.log(`   - ${idx}`));
    console.log();
  } finally {
    client.release();
  }
}

async function main() {
  console.log("🚀 开始 subscription_periods 数据库测试\n");
  
  try {
    await cleanup();
    
    const userId = await testUserCreation();
    const { periodId, subscriptionId } = await testSubscriptionPeriodInsert(userId);
    await testCurrentPeriodQuery(userId);
    await testPeriodsToApplyBudget();
    await testMarkBudgetApplied(periodId);
    await testEndedSubscriptions();
    await testIndexes();
    
    console.log("✅ 所有数据库测试通过!\n");
    
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
