#!/usr/bin/env node
/**
 * 支付+容器流程测试（不依赖 LiteLLM）
 * 直接在数据库层面创建用户和助理，然后测试支付流程
 */

import "dotenv/config";
import pg from "pg";
import { setTimeout as sleep } from "node:timers/promises";

const API_BASE = process.env.API_BASE_URL || "http://localhost:3000";
const API_KEY = process.env.API_INTERNAL_TOKEN;
const DB_URL = process.env.SUPABASE_DB_URL;
const RUNTIME = process.env.CONTAINER_RUNTIME || "docker";

if (!API_KEY) {
  console.error("❌ API_INTERNAL_TOKEN 未配置");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL });
const TEST_TELEGRAM_ID = 555444333;
const TEST_BOT_ID = TEST_TELEGRAM_ID;

let serverProcess = null;

async function startDevServer() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log("✅ Dev server 已在运行\n");
      return null;
    }
  } catch (e) {}
  
  console.log("🚀 启动 dev server...");
  const { spawn } = await import("node:child_process");
  
  const server = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.log("✅ Dev server 启动成功\n");
        return server;
      }
    } catch (e) {}
    if (server.exitCode !== null) throw new Error("Server failed to start");
  }
  
  server.kill();
  throw new Error("Server timeout");
}

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

async function step1_CreateUserAndAssistantInDB() {
  console.log("📌 步骤 1: 在数据库中创建用户和助理");
  console.log("=".repeat(60));
  
  const client = await pool.connect();
  try {
    // 创建用户
    const gatewayToken = `gw_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const userResult = await client.query(
      `INSERT INTO users (telegram_user_id, telegram_username, gateway_token)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [TEST_TELEGRAM_ID, "payment_test_user", gatewayToken]
    );
    
    const userId = userResult.rows[0].id;
    console.log(`✅ 用户已创建: user_id=${userId}, telegram_user_id=${TEST_TELEGRAM_ID}`);
    
    // 创建助理（不启动容器）
    const botToken = `${TEST_BOT_ID}:AAH-payment-test-${Date.now()}`;
    const assistantResult = await client.query(
      `INSERT INTO assistants (owner_user_id, assistant_bot_id, assistant_bot_token, assistant_bot_username)
       VALUES ($1, $2, $3, $4)
       RETURNING id, assistant_bot_id`,
      [userId, TEST_BOT_ID, botToken, "payment_test_bot"]
    );
    
    const assistantId = assistantResult.rows[0].id;
    console.log(`✅ 助理已创建: assistant_id=${assistantId}, bot_id=${TEST_BOT_ID}\n`);
    
    return { userId, assistantId };
  } finally {
    client.release();
  }
}

async function step2_CreateSubscriptionPeriod() {
  console.log("📌 步骤 2: 模拟支付成功，创建订阅周期");
  console.log("=".repeat(60));
  
  const client = await pool.connect();
  try {
    // 获取 plan
    const planResult = await client.query(
      "SELECT plan_code FROM billing_plans ORDER BY monthly_refresh_credits DESC LIMIT 1"
    );
    if (planResult.rows.length === 0) throw new Error("No billing plans");
    
    const planCode = planResult.rows[0].plan_code;
    
    // 获取 user_id
    const userResult = await client.query(
      "SELECT id FROM users WHERE telegram_user_id = $1",
      [TEST_TELEGRAM_ID]
    );
    const userId = userResult.rows[0].id;
    
    const now = new Date();
    const periodStart = new Date(now.getTime() - 1000);
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    const subscriptionId = `sub_payment_test_${Date.now()}`;
    const customerId = `cus_payment_test_${TEST_TELEGRAM_ID}`;
    const invoiceId = `in_payment_test_${Date.now()}`;
    
    const result = await client.query(
      `INSERT INTO subscription_periods (
        user_id, stripe_subscription_id, stripe_customer_id, stripe_invoice_id,
        period_start, period_end, plan_id, status, cancel_at_period_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', false)
      RETURNING id`,
      [userId, subscriptionId, customerId, invoiceId, periodStart, periodEnd, planCode]
    );
    
    const periodId = result.rows[0].id;
    
    console.log("✅ subscription_periods 记录已创建:");
    console.log(`   period_id: ${periodId}`);
    console.log(`   subscription_id: ${subscriptionId}`);
    console.log(`   plan_id: ${planCode}`);
    console.log(`   period: ${periodStart.toISOString()} → ${periodEnd.toISOString()}\n`);
    
    return { periodId, subscriptionId, planCode };
  } finally {
    client.release();
  }
}

async function step3_VerifyCurrentPeriod() {
  console.log("📌 步骤 3: 验证当前生效周期查询");
  console.log("=".repeat(60));
  
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT sp.id, sp.stripe_subscription_id, sp.plan_id, sp.status,
              sp.period_start, sp.period_end, sp.budget_applied_at
       FROM subscription_periods sp
       JOIN users u ON u.id = sp.user_id
       WHERE u.telegram_user_id = $1
         AND sp.period_start <= NOW()
         AND sp.period_end > NOW()
       LIMIT 1`,
      [TEST_TELEGRAM_ID]
    );
    
    if (result.rows.length === 0) {
      throw new Error("未找到当前生效周期");
    }
    
    const period = result.rows[0];
    console.log("✅ 找到当前生效周期:");
    console.log(`   period_id: ${period.id}`);
    console.log(`   subscription_id: ${period.stripe_subscription_id}`);
    console.log(`   plan_id: ${period.plan_id}`);
    console.log(`   status: ${period.status}`);
    console.log(`   budget_applied_at: ${period.budget_applied_at || "(未应用)"}\n`);
    
    return period;
  } finally {
    client.release();
  }
}

async function step4_StartContainer() {
  console.log("📌 步骤 4: 启动容器");
  console.log("=".repeat(60));
  
  // 获取 assistant_id
  const client = await pool.connect();
  let assistantId;
  try {
    const result = await client.query(
      `SELECT a.id FROM assistants a
       JOIN users u ON u.id = a.owner_user_id
       WHERE u.telegram_user_id = $1`,
      [TEST_TELEGRAM_ID]
    );
    assistantId = result.rows[0].id;
  } finally {
    client.release();
  }
  
  console.log(`调用容器启动 API (assistant_id=${assistantId})...`);
  
  const res = await fetch(`${API_BASE}/api/container/start/${assistantId}`, {
    method: "POST",
    headers: { "X-Api-Key": API_KEY }
  });
  
  if (!res.ok) {
    const text = await res.text();
    console.log(`⚠️  容器启动失败 ${res.status}: ${text}`);
    console.log("   (可能是因为缺少 LiteLLM，这是预期的)\n");
    return null;
  }
  
  const data = await res.json();
  console.log("✅ 容器启动请求成功:");
  console.log(`   container_id: ${data.container_id || data.containerId}`);
  console.log(`   ready: ${data.ready}\n`);
  
  return data;
}

async function step5_CheckRuntimeInstances() {
  console.log("📌 步骤 5: 检查 runtime_instances 表");
  console.log("=".repeat(60));
  
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT ri.*
       FROM runtime_instances ri
       JOIN assistants a ON a.id = ri.assistant_id
       JOIN users u ON u.id = a.owner_user_id
       WHERE u.telegram_user_id = $1 AND ri.scope = 'assistant'`,
      [TEST_TELEGRAM_ID]
    );
    
    if (result.rows.length === 0) {
      console.log("ℹ️  runtime_instances 表中无记录（可能容器启动失败）\n");
      return null;
    }
    
    const runtime = result.rows[0];
    console.log("✅ 找到容器运行时记录:");
    console.log(`   runtime_ref: ${runtime.runtime_ref}`);
    console.log(`   container_name: ${runtime.container_name}`);
    console.log(`   status: ${runtime.status}`);
    console.log(`   host_port: ${runtime.host_port}\n`);
    
    return runtime;
  } finally {
    client.release();
  }
}

async function showSummary() {
  console.log("\n" + "=".repeat(60));
  console.log("📊 最终数据状态");
  console.log("=".repeat(60));
  
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT 
        u.id as user_id,
        u.telegram_user_id,
        u.telegram_username,
        a.id as assistant_id,
        a.assistant_bot_id,
        sp.id as period_id,
        sp.stripe_subscription_id,
        sp.plan_id,
        sp.status as period_status,
        sp.budget_applied_at
       FROM users u
       LEFT JOIN assistants a ON a.owner_user_id = u.id
       LEFT JOIN subscription_periods sp ON sp.user_id = u.id
       WHERE u.telegram_user_id = $1
       ORDER BY sp.created_at DESC
       LIMIT 1`,
      [TEST_TELEGRAM_ID]
    );
    
    if (result.rows.length > 0) {
      console.log("\n测试数据:");
      console.log(JSON.stringify(result.rows[0], null, 2));
    }
    
    console.log("\n查询命令:");
    console.log(`  SELECT * FROM users WHERE telegram_user_id = ${TEST_TELEGRAM_ID};`);
    console.log(`  SELECT * FROM subscription_periods sp JOIN users u ON u.id = sp.user_id WHERE u.telegram_user_id = ${TEST_TELEGRAM_ID};`);
    
  } finally {
    client.release();
  }
}

async function main() {
  console.log("\n🚀 支付+容器流程测试");
  console.log("=".repeat(60));
  console.log(`API_BASE: ${API_BASE}`);
  console.log(`RUNTIME: ${RUNTIME}`);
  console.log(`TEST_TELEGRAM_ID: ${TEST_TELEGRAM_ID}\n`);
  
  try {
    serverProcess = await startDevServer();
    await cleanup();
    
    await step1_CreateUserAndAssistantInDB();
    await step2_CreateSubscriptionPeriod();
    await step3_VerifyCurrentPeriod();
    await step4_StartContainer();
    await step5_CheckRuntimeInstances();
    
    await showSummary();
    
    console.log("\n" + "=".repeat(60));
    console.log("✅ 测试完成！");
    console.log("=".repeat(60));
    console.log("\n⚠️  数据已保留，可在数据库中查看\n");
    
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    if (error.stack) console.error("\n" + error.stack);
    process.exit(1);
  } finally {
    if (serverProcess) {
      console.log("⏹️  停止 dev server...");
      serverProcess.kill();
      await sleep(2000);
    }
    await pool.end();
  }
}

main();
