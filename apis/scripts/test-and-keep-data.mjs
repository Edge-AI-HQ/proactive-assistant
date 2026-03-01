#!/usr/bin/env node
/**
 * 运行测试但保留数据（不清理），方便在数据库里查看
 */

import "dotenv/config";
import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error("❌ SUPABASE_DB_URL 未配置");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL });
const TEST_TELEGRAM_ID = 888777666;

// 导入模块
const { db } = await import("../dist/src/domain/payment/db.js");
const { pool: dbPool } = await import("../dist/src/domain/common/db/core.js");

async function createUser() {
  console.log("1️⃣ 创建测试用户...");
  const client = await dbPool.connect();
  try {
    // 先检查是否已存在
    const existing = await client.query(
      "SELECT id FROM users WHERE telegram_user_id = $1",
      [TEST_TELEGRAM_ID]
    );
    
    if (existing.rows.length > 0) {
      console.log(`✅ 用户已存在: id=${existing.rows[0].id}\n`);
      return existing.rows[0];
    }
    
    const gatewayToken = `gw_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = await client.query(
      `INSERT INTO users (telegram_user_id, telegram_username, gateway_token)
       VALUES ($1, $2, $3)
       RETURNING id, telegram_user_id`,
      [TEST_TELEGRAM_ID, "test_user_keep", gatewayToken]
    );
    
    const user = result.rows[0];
    console.log(`✅ 用户已创建: id=${user.id}, telegram_user_id=${user.telegram_user_id}\n`);
    return user;
  } finally {
    client.release();
  }
}

async function insertSubscriptionPeriod() {
  console.log("2️⃣ 插入订阅周期...");
  
  // 获取 plan
  const client = await dbPool.connect();
  let planCode;
  try {
    const planResult = await client.query(
      "SELECT plan_code FROM billing_plans ORDER BY monthly_refresh_credits DESC LIMIT 1"
    );
    if (planResult.rows.length === 0) {
      throw new Error("billing_plans 表为空");
    }
    planCode = planResult.rows[0].plan_code;
  } finally {
    client.release();
  }
  
  const subscriptionId = `sub_keep_${Date.now()}`;
  const customerId = `cus_keep_${TEST_TELEGRAM_ID}`;
  const invoiceId = `in_keep_${Date.now()}`;
  const now = new Date();
  const periodStart = new Date(now.getTime() - 1000);
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  
  await db.upsertSubscriptionPeriod({
    telegram_user_id: String(TEST_TELEGRAM_ID),
    telegram_username: "test_user_keep",
    stripe_subscription_id: subscriptionId,
    stripe_customer_id: customerId,
    stripe_invoice_id: invoiceId,
    period_start: periodStart,
    period_end: periodEnd,
    plan_id: planCode,
    status: "active",
    cancel_at_period_end: false
  });
  
  console.log("✅ 订阅周期已插入:");
  console.log(`   subscription_id: ${subscriptionId}`);
  console.log(`   invoice_id: ${invoiceId}`);
  console.log(`   plan_id: ${planCode}`);
  console.log(`   period_start: ${periodStart.toISOString()}`);
  console.log(`   period_end: ${periodEnd.toISOString()}\n`);
  
  return subscriptionId;
}

async function queryCurrentPeriod() {
  console.log("3️⃣ 查询当前生效周期...");
  
  const period = await db.getCurrentPeriodByTelegramId(TEST_TELEGRAM_ID);
  
  if (period) {
    console.log("✅ 找到当前周期:");
    console.log(`   stripe_subscription_id: ${period.stripe_subscription_id}`);
    console.log(`   plan_id: ${period.plan_id}`);
    console.log(`   status: ${period.status}\n`);
  } else {
    console.log("❌ 未找到当前周期\n");
  }
  
  return period;
}

async function showDatabaseQueries() {
  console.log("📊 数据库查询示例（你可以在数据库客户端里执行）:\n");
  
  console.log("-- 查看测试用户");
  console.log(`SELECT * FROM users WHERE telegram_user_id = ${TEST_TELEGRAM_ID};\n`);
  
  console.log("-- 查看该用户的订阅周期");
  console.log(`SELECT sp.*
FROM subscription_periods sp
JOIN users u ON u.id = sp.user_id
WHERE u.telegram_user_id = ${TEST_TELEGRAM_ID};\n`);
  
  console.log("-- 查看所有待应用 budget 的周期");
  console.log(`SELECT 
  sp.id, sp.stripe_subscription_id, sp.plan_id,
  u.telegram_user_id, sp.period_start, sp.period_end,
  sp.budget_applied_at
FROM subscription_periods sp
JOIN users u ON u.id = sp.user_id
WHERE sp.budget_applied_at IS NULL
  AND sp.period_start <= NOW()
  AND sp.period_end > NOW()
ORDER BY sp.period_start ASC;\n`);
}

async function main() {
  console.log("🚀 运行测试并保留数据\n");
  console.log("TEST_TELEGRAM_ID:", TEST_TELEGRAM_ID);
  console.log("⚠️  注意：此脚本不会清理数据，数据会保留在数据库中\n");
  
  try {
    await createUser();
    await insertSubscriptionPeriod();
    await queryCurrentPeriod();
    
    console.log("\n✅ 测试完成，数据已保留在数据库中!\n");
    
    showDatabaseQueries();
    
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await dbPool.end();
    await pool.end();
  }
}

main();
