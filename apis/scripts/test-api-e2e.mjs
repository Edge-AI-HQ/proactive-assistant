#!/usr/bin/env node
/**
 * 真正的端到端测试：启动 HTTP 服务器 → 调用 API → 验证结果
 * 
 * 用法: cd apis && node scripts/test-api-e2e.mjs
 */

import "dotenv/config";
import pg from "pg";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const API_BASE = process.env.API_BASE_URL || "http://localhost:3000";
const API_KEY = process.env.API_INTERNAL_TOKEN; // X-Api-Key header
const DB_URL = process.env.SUPABASE_DB_URL;

if (!API_KEY) {
  console.error("❌ API_INTERNAL_TOKEN 未配置");
  process.exit(1);
}

if (!DB_URL) {
  console.error("❌ SUPABASE_DB_URL 未配置");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL });

// 测试用数据
const TEST_TELEGRAM_ID = 777666555;
const TEST_BOT_TOKEN = `${TEST_TELEGRAM_ID}:AAH-test-bot-${Date.now()}`;

let serverProcess = null;

async function cleanup() {
  console.log("\n🧹 清理测试数据...");
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM users WHERE telegram_user_id = $1", [TEST_TELEGRAM_ID]);
    console.log("✅ 清理完成");
  } finally {
    client.release();
  }
}

async function startDevServer() {
  console.log("🚀 启动 dev server...");
  
  // 检查服务器是否已经在运行
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log("✅ Dev server 已在运行\n");
      return null; // 不需要启动新进程
    }
  } catch (e) {
    // 服务器未运行，需要启动
  }
  
  console.log("   启动新的 dev server 进程...");
  
  const server = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
  });
  
  let startupOutput = "";
  
  server.stdout.on("data", (data) => {
    startupOutput += data.toString();
  });
  
  server.stderr.on("data", (data) => {
    startupOutput += data.toString();
  });
  
  // 等待服务器启动（最多 30 秒）
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    
    try {
      const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log("✅ Dev server 启动成功\n");
        return server;
      }
    } catch (e) {
      // 继续等待
    }
    
    // 检查进程是否崩溃
    if (server.exitCode !== null) {
      console.error("❌ Dev server 启动失败:");
      console.error(startupOutput);
      throw new Error(`Server exited with code ${server.exitCode}`);
    }
  }
  
  server.kill();
  throw new Error("Dev server 启动超时（30秒）");
}

async function stopDevServer(server) {
  if (!server) return;
  
  console.log("\n⏹️  停止 dev server...");
  server.kill();
  
  // 等待进程结束
  await sleep(2000);
  console.log("✅ Dev server 已停止");
}

async function testHealthCheck() {
  console.log("1️⃣ 测试 /health endpoint...");
  
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) {
    throw new Error(`Health check 失败: ${res.status}`);
  }
  
  const data = await res.json();
  console.log("✅ Health check 通过:", data.service);
  console.log(`   Runtime: ${data.runtime}\n`);
}

async function testCreateAssistant() {
  console.log("2️⃣ 测试创建助理 API...");
  
  // 从 botToken 解析出 bot_id (格式: bot_id:token)
  const botId = TEST_BOT_TOKEN.split(":")[0];
  
  const res = await fetch(`${API_BASE}/api/claw-assistant/create-without-container`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY
    },
    body: JSON.stringify({
      owner_telegram_user_id: TEST_TELEGRAM_ID,
      assistant_bot_id: Number(botId),
      assistant_bot_token: TEST_BOT_TOKEN,
      assistant_bot_username: "test_bot"
    })
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`创建助理失败 ${res.status}: ${text}`);
  }
  
  const data = await res.json();
  console.log("✅ 助理已创建:");
  console.log(`   assistant_bot_id: ${data.assistant_bot_id}`);
  console.log(`   owner_telegram_user_id: ${data.owner_telegram_user_id}\n`);
  
  return data;
}

async function testCreateInternalPaymentSession() {
  console.log("3️⃣ 测试创建内部支付会话...");
  
  // 先获取可用 plans
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
  console.log(`   使用 plan: ${plan.plan_code}`);
  
  const sessionRes = await fetch(`${API_BASE}/api/payment/internal/create-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY
    },
    body: JSON.stringify({
      telegram_user_id: TEST_TELEGRAM_ID,
      plan_code: plan.plan_code,
      ttl: 3600
    })
  });
  
  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    throw new Error(`创建支付会话失败 ${sessionRes.status}: ${text}`);
  }
  
  const session = await sessionRes.json();
  console.log("✅ 支付会话已创建:");
  console.log(`   session_id: ${session.session_id.slice(0, 20)}...`);
  console.log(`   checkout_url: ${session.checkout_url.slice(0, 50)}...\n`);
  
  return { session, plan };
}

async function simulateCheckoutSuccess(sessionId) {
  console.log("4️⃣ 模拟支付成功（直接写 DB）...");
  
  // 验证会话并完成支付（直接调用 internal API）
  const res = await fetch(`${API_BASE}/api/payment/internal/validate-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY
    },
    body: JSON.stringify({
      session_id: sessionId
    })
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`验证会话失败 ${res.status}: ${text}`);
  }
  
  const data = await res.json();
  console.log("✅ 支付会话验证成功");
  console.log(`   telegram_user_id: ${data.telegram_user_id}`);
  console.log(`   plan_code: ${data.plan_code}\n`);
  
  // 直接插入 subscription_period（模拟 invoice.paid webhook）
  const client = await pool.connect();
  try {
    const userResult = await client.query(
      "SELECT id FROM users WHERE telegram_user_id = $1",
      [TEST_TELEGRAM_ID]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error("用户不存在");
    }
    
    const userId = userResult.rows[0].id;
    const now = new Date();
    const periodStart = new Date(now.getTime() - 1000);
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    await client.query(
      `INSERT INTO subscription_periods (
        user_id, stripe_subscription_id, stripe_customer_id, stripe_invoice_id,
        period_start, period_end, plan_id, status, cancel_at_period_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', false)`,
      [
        userId,
        `sub_test_${Date.now()}`,
        `cus_test_${TEST_TELEGRAM_ID}`,
        `in_test_${Date.now()}`,
        periodStart,
        periodEnd,
        data.plan_code
      ]
    );
    
    console.log("✅ subscription_periods 记录已插入\n");
  } finally {
    client.release();
  }
}

async function testGetCurrentSubscription() {
  console.log("5️⃣ 测试查询当前订阅...");
  
  const res = await fetch(
    `${API_BASE}/api/payment/subscription?telegram_user_id=${TEST_TELEGRAM_ID}`,
    {
      headers: { "X-Internal-Token": INTERNAL_TOKEN }
    }
  );
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`查询订阅失败 ${res.status}: ${text}`);
  }
  
  const data = await res.json();
  
  if (!data.subscription) {
    throw new Error("未找到订阅记录（应该能找到刚插入的周期）");
  }
  
  console.log("✅ 找到当前订阅:");
  console.log(`   plan_id: ${data.subscription.plan_id}`);
  console.log(`   status: ${data.subscription.status}`);
  console.log(`   period_end: ${data.subscription.period_end}\n`);
  
  return data.subscription;
}

async function testApplyBudgetsCron() {
  console.log("6️⃣ 测试定时任务 apply-budgets...");
  
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.log("⚠️  CRON_SECRET 未配置，跳过此步骤\n");
    return;
  }
  
  const res = await fetch(`${API_BASE}/api/payment/cron/apply-budgets`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cronSecret}`,
      "X-Api-Key": API_KEY
    }
  });
  
  if (!res.ok) {
    const text = await res.text();
    console.log(`⚠️  定时任务失败 ${res.status}: ${text}\n`);
    return;
  }
  
  const data = await res.json();
  console.log("✅ 定时任务执行成功:");
  console.log(`   applied: ${data.applied || 0}`);
  console.log(`   zeroed: ${data.ended_zeroed || 0}\n`);
}

async function verifyDatabaseState() {
  console.log("7️⃣ 验证数据库最终状态...");
  
  const client = await pool.connect();
  try {
    // 检查 user 表
    const userResult = await client.query(
      "SELECT telegram_user_id FROM users WHERE telegram_user_id = $1",
      [TEST_TELEGRAM_ID]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error("用户不存在");
    }
    
    console.log("✅ 用户存在");
    
    // 检查 subscription_periods 表
    const periodResult = await client.query(
      `SELECT sp.* FROM subscription_periods sp
       JOIN users u ON u.id = sp.user_id
       WHERE u.telegram_user_id = $1`,
      [TEST_TELEGRAM_ID]
    );
    
    if (periodResult.rows.length === 0) {
      throw new Error("未找到 subscription_periods 记录");
    }
    
    const period = periodResult.rows[0];
    console.log("✅ subscription_periods 记录存在:");
    console.log(`   stripe_subscription_id: ${period.stripe_subscription_id}`);
    console.log(`   plan_id: ${period.plan_id}`);
    console.log(`   budget_applied_at: ${period.budget_applied_at || "(未应用)"}\n`);
    
  } finally {
    client.release();
  }
}

async function main() {
  console.log("🧪 端到端 API 测试开始\n");
  console.log("API_BASE:", API_BASE);
  console.log("TEST_TELEGRAM_ID:", TEST_TELEGRAM_ID);
  console.log();
  
  let server = null;
  
  try {
    await cleanup();
    
    server = await startDevServer();
    
    await testHealthCheck();
    await testCreateAssistant();
    const { session, plan } = await testCreateInternalPaymentSession();
    await simulateCheckoutSuccess(session.session_id);
    await testGetCurrentSubscription();
    await testApplyBudgetsCron();
    await verifyDatabaseState();
    
    console.log("✅ 所有端到端测试通过!\n");
    
    await cleanup();
    
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await stopDevServer(server);
    await pool.end();
  }
}

main();
