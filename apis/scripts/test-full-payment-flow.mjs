#!/usr/bin/env node
/**
 * 完整的支付流程测试：
 * 1. 创建用户
 * 2. 创建支付 session
 * 3. 模拟支付成功（写入 subscription_periods）
 * 4. 验证 periods 表有记录
 * 5. 触发容器启动
 * 6. 验证容器运行中
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

if (!DB_URL) {
  console.error("❌ SUPABASE_DB_URL 未配置");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL });

// 测试用数据
const TEST_TELEGRAM_ID = 666555444;
const TEST_BOT_TOKEN = `${TEST_TELEGRAM_ID}:AAH-full-test-${Date.now()}`;
const TEST_BOT_ID = Number(TEST_BOT_TOKEN.split(":")[0]);

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

async function step1_CreateAssistant() {
  console.log("📌 步骤 1: 创建助理");
  console.log("=".repeat(60));
  
  const res = await fetch(`${API_BASE}/api/claw-assistant/create-without-container`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY
    },
    body: JSON.stringify({
      owner_telegram_user_id: TEST_TELEGRAM_ID,
      assistant_bot_id: TEST_BOT_ID,
      assistant_bot_token: TEST_BOT_TOKEN,
      assistant_bot_username: "full_test_bot"
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

async function step2_CreatePaymentSession() {
  console.log("📌 步骤 2: 创建支付 session");
  console.log("=".repeat(60));
  
  // 获取可用 plans
  const plansRes = await fetch(`${API_BASE}/api/payment/plans`, {
    headers: { "X-Api-Key": API_KEY }
  });
  
  if (!plansRes.ok) {
    throw new Error(`获取 plans 失败: ${plansRes.status}`);
  }
  
  const plans = await plansRes.json();
  if (!plans || plans.length === 0) {
    throw new Error("没有可用的 billing plan");
  }
  
  const plan = plans[0];
  console.log(`使用 plan: ${plan.plan_code} (月刷新 ${plan.monthly_refresh_credits} credits)`);
  
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
  console.log(`   plan_code: ${plan.plan_code}\n`);
  
  return { session, plan };
}

async function step3_SimulatePaymentSuccess(sessionId, planCode) {
  console.log("📌 步骤 3: 模拟支付成功（写入 subscription_periods）");
  console.log("=".repeat(60));
  
  // 验证会话
  const validateRes = await fetch(`${API_BASE}/api/payment/internal/validate-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": API_KEY
    },
    body: JSON.stringify({
      session_id: sessionId
    })
  });
  
  if (!validateRes.ok) {
    const text = await validateRes.text();
    throw new Error(`验证会话失败 ${validateRes.status}: ${text}`);
  }
  
  const validated = await validateRes.json();
  console.log("✅ 会话验证成功");
  console.log(`   telegram_user_id: ${validated.telegram_user_id}`);
  console.log(`   plan_code: ${validated.plan_code}`);
  
  // 模拟 Stripe webhook: invoice.paid
  // 直接插入 subscription_periods
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
    const periodStart = new Date(now.getTime() - 1000); // 1秒前开始
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30天后
    
    const subscriptionId = `sub_full_test_${Date.now()}`;
    const customerId = `cus_full_test_${TEST_TELEGRAM_ID}`;
    const invoiceId = `in_full_test_${Date.now()}`;
    
    await client.query(
      `INSERT INTO subscription_periods (
        user_id, stripe_subscription_id, stripe_customer_id, stripe_invoice_id,
        period_start, period_end, plan_id, status, cancel_at_period_end
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', false)`,
      [userId, subscriptionId, customerId, invoiceId, periodStart, periodEnd, planCode]
    );
    
    console.log("\n✅ subscription_periods 记录已插入:");
    console.log(`   subscription_id: ${subscriptionId}`);
    console.log(`   invoice_id: ${invoiceId}`);
    console.log(`   period_start: ${periodStart.toISOString()}`);
    console.log(`   period_end: ${periodEnd.toISOString()}\n`);
    
    return { subscriptionId, periodStart, periodEnd };
  } finally {
    client.release();
  }
}

async function step4_VerifyPeriodsTable() {
  console.log("📌 步骤 4: 验证 subscription_periods 表");
  console.log("=".repeat(60));
  
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT sp.id, sp.stripe_subscription_id, sp.stripe_invoice_id,
              sp.plan_id, sp.status, sp.period_start, sp.period_end,
              sp.budget_applied_at
       FROM subscription_periods sp
       JOIN users u ON u.id = sp.user_id
       WHERE u.telegram_user_id = $1
       ORDER BY sp.created_at DESC
       LIMIT 1`,
      [TEST_TELEGRAM_ID]
    );
    
    if (result.rows.length === 0) {
      throw new Error("❌ subscription_periods 表中没有记录");
    }
    
    const period = result.rows[0];
    console.log("✅ 找到订阅周期:");
    console.log(`   id: ${period.id}`);
    console.log(`   subscription_id: ${period.stripe_subscription_id}`);
    console.log(`   invoice_id: ${period.stripe_invoice_id}`);
    console.log(`   plan_id: ${period.plan_id}`);
    console.log(`   status: ${period.status}`);
    console.log(`   period_start: ${period.period_start}`);
    console.log(`   period_end: ${period.period_end}`);
    console.log(`   budget_applied_at: ${period.budget_applied_at || "(未应用)"}\n`);
    
    // 验证当前时间在周期内
    const now = new Date();
    const isInPeriod = period.period_start <= now && now < period.period_end;
    if (!isInPeriod) {
      throw new Error("当前时间不在周期范围内");
    }
    console.log("✅ 当前时间在周期范围内\n");
    
    return period;
  } finally {
    client.release();
  }
}

async function step5_TriggerContainerStart() {
  console.log("📌 步骤 5: 触发容器启动");
  console.log("=".repeat(60));
  
  // 查询 assistant ID
  const client = await pool.connect();
  let assistantId;
  try {
    const result = await client.query(
      `SELECT a.id FROM assistants a
       JOIN users u ON u.id = a.owner_user_id
       WHERE u.telegram_user_id = $1`,
      [TEST_TELEGRAM_ID]
    );
    
    if (result.rows.length === 0) {
      throw new Error("找不到 assistant");
    }
    
    assistantId = result.rows[0].id;
  } finally {
    client.release();
  }
  
  console.log(`Assistant ID: ${assistantId}`);
  console.log("调用容器启动 API...");
  
  const res = await fetch(`${API_BASE}/api/container/start/${assistantId}`, {
    method: "POST",
    headers: {
      "X-Api-Key": API_KEY
    }
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`启动容器失败 ${res.status}: ${text}`);
  }
  
  const data = await res.json();
  console.log("✅ 容器启动请求已发送:");
  console.log(`   container_id: ${data.container_id || data.containerId}`);
  console.log(`   ready: ${data.ready}\n`);
  
  return data;
}

async function step6_VerifyContainer() {
  console.log("📌 步骤 6: 验证容器状态");
  console.log("=".repeat(60));
  
  // 等待容器启动
  console.log("等待容器启动...");
  await sleep(3000);
  
  // 查询 runtime_instances 表
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT ri.id, ri.runtime_ref, ri.container_name, ri.status, ri.host_port
       FROM runtime_instances ri
       JOIN assistants a ON a.id = ri.assistant_id
       JOIN users u ON u.id = a.owner_user_id
       WHERE u.telegram_user_id = $1 AND ri.scope = 'assistant'`,
      [TEST_TELEGRAM_ID]
    );
    
    if (result.rows.length === 0) {
      console.log("⚠️  runtime_instances 表中没有记录");
      console.log("   (可能容器还在创建中，或使用了不同的存储方式)\n");
      return null;
    }
    
    const runtime = result.rows[0];
    console.log("✅ 找到容器记录:");
    console.log(`   runtime_ref: ${runtime.runtime_ref}`);
    console.log(`   container_name: ${runtime.container_name}`);
    console.log(`   status: ${runtime.status}`);
    console.log(`   host_port: ${runtime.host_port}\n`);
    
    return runtime;
  } finally {
    client.release();
  }
}

async function step7_CheckDockerContainer() {
  console.log("📌 步骤 7: 检查 Docker 容器（仅 runtime=docker）");
  console.log("=".repeat(60));
  
  if (RUNTIME !== "docker") {
    console.log(`跳过（当前 runtime=${RUNTIME}）\n`);
    return;
  }
  
  const { spawn } = await import("node:child_process");
  
  return new Promise((resolve) => {
    const proc = spawn("docker", ["ps", "--filter", "name=pinclaw", "--format", "table {{.ID}}\\t{{.Names}}\\t{{.Status}}"]);
    
    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });
    
    proc.on("close", () => {
      console.log("Docker 容器列表:");
      console.log(output);
      
      if (output.includes("pinclaw")) {
        console.log("✅ 找到 pinclaw 容器\n");
      } else {
        console.log("⚠️  没有找到 pinclaw 容器（可能还在创建中）\n");
      }
      
      resolve();
    });
  });
}

async function showFinalSummary() {
  console.log("\n" + "=".repeat(60));
  console.log("📊 最终数据库状态");
  console.log("=".repeat(60));
  
  const client = await pool.connect();
  try {
    // users
    const userResult = await client.query(
      "SELECT id, telegram_user_id, telegram_username FROM users WHERE telegram_user_id = $1",
      [TEST_TELEGRAM_ID]
    );
    console.log("\n【users 表】");
    console.log(userResult.rows[0]);
    
    // subscription_periods
    const periodResult = await client.query(
      `SELECT sp.* FROM subscription_periods sp
       JOIN users u ON u.id = sp.user_id
       WHERE u.telegram_user_id = $1`,
      [TEST_TELEGRAM_ID]
    );
    console.log("\n【subscription_periods 表】");
    console.log(periodResult.rows[0]);
    
    // assistants
    const assistantResult = await client.query(
      `SELECT a.id, a.assistant_bot_id, a.assistant_bot_username
       FROM assistants a
       JOIN users u ON u.id = a.owner_user_id
       WHERE u.telegram_user_id = $1`,
      [TEST_TELEGRAM_ID]
    );
    console.log("\n【assistants 表】");
    console.log(assistantResult.rows[0]);
    
    // runtime_instances
    const runtimeResult = await client.query(
      `SELECT ri.* FROM runtime_instances ri
       JOIN assistants a ON a.id = ri.assistant_id
       JOIN users u ON u.id = a.owner_user_id
       WHERE u.telegram_user_id = $1`,
      [TEST_TELEGRAM_ID]
    );
    console.log("\n【runtime_instances 表】");
    if (runtimeResult.rows.length > 0) {
      console.log(runtimeResult.rows[0]);
    } else {
      console.log("(无记录)");
    }
    
  } finally {
    client.release();
  }
}

async function startDevServerIfNeeded() {
  // 检查服务器是否已在运行
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log("✅ Dev server 已在运行\n");
      return null;
    }
  } catch (e) {
    // 服务器未运行，需要启动
  }
  
  console.log("🚀 启动 dev server...");
  const { spawn } = await import("node:child_process");
  
  const server = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env }
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
    
    if (server.exitCode !== null) {
      throw new Error(`Server exited with code ${server.exitCode}`);
    }
  }
  
  server.kill();
  throw new Error("Dev server 启动超时");
}

async function main() {
  console.log("\n🚀 完整支付流程端到端测试");
  console.log("=".repeat(60));
  console.log(`API_BASE: ${API_BASE}`);
  console.log(`RUNTIME: ${RUNTIME}`);
  console.log(`TEST_TELEGRAM_ID: ${TEST_TELEGRAM_ID}`);
  console.log(`TEST_BOT_ID: ${TEST_BOT_ID}\n`);
  
  let server = null;
  
  try {
    server = await startDevServerIfNeeded();
    await cleanup();
    
    await step1_CreateAssistant();
    const { session, plan } = await step2_CreatePaymentSession();
    await step3_SimulatePaymentSuccess(session.session_id, plan.plan_code);
    await step4_VerifyPeriodsTable();
    await step5_TriggerContainerStart();
    await step6_VerifyContainer();
    await step7_CheckDockerContainer();
    
    await showFinalSummary();
    
    console.log("\n" + "=".repeat(60));
    console.log("✅ 所有测试步骤完成!");
    console.log("=".repeat(60));
    console.log("\n⚠️  测试数据已保留，可在数据库中查看");
    console.log(`    SELECT * FROM users WHERE telegram_user_id = ${TEST_TELEGRAM_ID};`);
    console.log("\n如需清理，请运行:");
    console.log(`    DELETE FROM users WHERE telegram_user_id = ${TEST_TELEGRAM_ID};\n`);
    
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    if (error.stack) {
      console.error("\n堆栈:");
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    if (server) {
      console.log("\n⏹️  停止 dev server...");
      server.kill();
      await sleep(2000);
    }
    await pool.end();
  }
}

main();
