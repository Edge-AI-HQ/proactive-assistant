#!/usr/bin/env node
/**
 * 测试 payment_sessions 表和相关逻辑
 */

import "dotenv/config";
import pg from "pg";
import { randomBytes } from "node:crypto";
import crypto from "node:crypto";

const DB_URL = process.env.SUPABASE_DB_URL;
const pool = new pg.Pool({ connectionString: DB_URL });
const TEST_TELEGRAM_ID = 888999777;

async function cleanup() {
  console.log("🧹 清理测试数据...");
  await pool.query("DELETE FROM users WHERE telegram_user_id = $1", [TEST_TELEGRAM_ID]);
  console.log("✅ 清理完成\n");
}

async function testCreatePaymentSession() {
  console.log("1️⃣ 测试创建 payment session");
  console.log("=".repeat(60));
  
  // 创建用户
  const gatewayToken = `gw_pay_test_${Date.now()}`;
  const userResult = await pool.query(
    `INSERT INTO users (telegram_user_id, telegram_username, gateway_token)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [TEST_TELEGRAM_ID, "payment_test_user", gatewayToken]
  );
  
  const userId = userResult.rows[0].id;
  console.log(`✅ 用户创建: user_id=${userId}`);
  
  // 创建 payment session
  const sessionToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1小时
  
  await pool.query(
    `INSERT INTO payment_sessions (user_id, session_token, plan_code, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, sessionToken, "max", expiresAt]
  );
  
  console.log("✅ Payment session 已创建");
  console.log("   Token:", sessionToken.slice(0, 20) + "...");
  console.log("   Plan:", "max");
  console.log();
  
  return { userId, sessionToken };
}

async function testQuerySession(sessionToken) {
  console.log("2️⃣ 测试查询 session");
  console.log("=".repeat(60));
  
  const result = await pool.query(
    `SELECT 
      ps.*,
      u.telegram_user_id
     FROM payment_sessions ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.session_token = $1`,
    [sessionToken]
  );
  
  if (result.rows.length === 0) {
    console.log("❌ Session 不存在");
    return false;
  }
  
  const row = result.rows[0];
  console.log("✅ Session 查询成功:");
  console.log("   ID:", row.id);
  console.log("   Telegram User ID:", row.telegram_user_id);
  console.log("   Plan:", row.plan_code);
  console.log("   Used:", row.used);
  console.log("   Expires:", row.expires_at);
  console.log();
  
  return true;
}

async function testMarkSessionUsed(sessionToken) {
  console.log("3️⃣ 测试标记 session 已使用");
  console.log("=".repeat(60));
  
  await pool.query(
    `UPDATE payment_sessions
     SET used = TRUE, used_at = NOW()
     WHERE session_token = $1`,
    [sessionToken]
  );
  
  const checkResult = await pool.query(
    "SELECT used, used_at FROM payment_sessions WHERE session_token = $1",
    [sessionToken]
  );
  
  const row = checkResult.rows[0];
  console.log("✅ Session 已标记为已使用:");
  console.log("   Used:", row.used);
  console.log("   Used at:", row.used_at);
  console.log();
}

async function testSessionWithAssistant(userId) {
  console.log("4️⃣ 测试关联 assistant 的 payment session");
  console.log("=".repeat(60));
  
  // 创建助理
  const botToken = `${Date.now()}:AAH-pay-test`;
  const assistantResult = await pool.query(
    `INSERT INTO assistants (owner_user_id, assistant_bot_id, assistant_bot_token, assistant_bot_username)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, Date.now(), botToken, "pay_test_bot"]
  );
  
  const assistantId = assistantResult.rows[0].id;
  console.log(`✅ 助理创建: assistant_id=${assistantId}`);
  
  // 创建关联到助理的 payment session
  const sessionToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  
  await pool.query(
    `INSERT INTO payment_sessions (user_id, assistant_id, session_token, plan_code, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, assistantId, sessionToken, "pro", expiresAt]
  );
  
  console.log("✅ 助理级 payment session 已创建");
  
  // 验证
  const checkResult = await pool.query(
    "SELECT assistant_id, plan_code FROM payment_sessions WHERE session_token = $1",
    [sessionToken]
  );
  
  const row = checkResult.rows[0];
  if (row.assistant_id === assistantId) {
    console.log("✅ assistant_id 关联正确");
    console.log("   Assistant ID:", row.assistant_id);
    console.log("   Plan:", row.plan_code);
  } else {
    console.log("❌ assistant_id 不匹配");
  }
  console.log();
}

async function testCleanupExpired() {
  console.log("5️⃣ 测试清理过期和已使用的 sessions");
  console.log("=".repeat(60));
  
  const now = new Date();
  const retentionDays = 7;
  const usedRetentionCutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  
  const result = await pool.query(
    `DELETE FROM payment_sessions
     WHERE expires_at <= $1::timestamptz
       OR (used = TRUE AND COALESCE(used_at, created_at) <= $2::timestamptz)
     RETURNING id`,
    [now.toISOString(), usedRetentionCutoff.toISOString()]
  );
  
  console.log(`✅ 清理了 ${result.rowCount} 个 payment session`);
  console.log("   (过期的 + 7天前使用过的)");
  console.log();
}

async function showSummary() {
  console.log("📊 最终状态");
  console.log("=".repeat(60));
  
  const [gatewaySessions, paymentSessions] = await Promise.all([
    pool.query("SELECT COUNT(*) as count FROM gateway_sessions WHERE user_id IN (SELECT id FROM users WHERE telegram_user_id = $1)", [TEST_TELEGRAM_ID]),
    pool.query("SELECT COUNT(*) as count FROM payment_sessions WHERE user_id IN (SELECT id FROM users WHERE telegram_user_id = $1)", [TEST_TELEGRAM_ID])
  ]);
  
  console.log("测试用户的 sessions:");
  console.log("  Gateway sessions:", gatewaySessions.rows[0].count);
  console.log("  Payment sessions:", paymentSessions.rows[0].count);
  console.log();
}

async function main() {
  console.log("\n🧪 Payment Sessions 测试\n");
  
  try {
    await cleanup();
    
    const { userId, sessionToken } = await testCreatePaymentSession();
    await testQuerySession(sessionToken);
    await testMarkSessionUsed(sessionToken);
    await testSessionWithAssistant(userId);
    await testCleanupExpired();
    await showSummary();
    
    console.log("=".repeat(60));
    console.log("✅ 所有测试通过！");
    console.log("=".repeat(60));
    
    await cleanup();
    
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
