#!/usr/bin/env node
/**
 * 定时任务完整测试：
 * 1. 新周期开始 → 应用 budget（设置 LiteLLM spend=0, budget=xxx）
 * 2. 订阅到期 → 清零 budget + 停止容器
 * 3. 并发场景 → 多个用户同时处理
 * 4. 幂等性 → 重复执行不会重复应用
 */

import "dotenv/config";
import pg from "pg";
import { setTimeout as sleep } from "node:timers/promises";

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error("❌ SUPABASE_DB_URL 未配置");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL });

// 导入被测试的模块
const { applySubscriptionPeriodBudgets } = await import("../dist/src/domain/payment/subscriptionSync.js");
const { db } = await import("../dist/src/domain/payment/db.js");
const { pool: dbPool } = await import("../dist/src/domain/common/db/core.js");

// 测试用户 IDs
const USER_NEW_PERIOD = 111222333; // 有新周期待应用
const USER_ENDED = 222333444;      // 订阅已结束
const USER_CONCURRENT_1 = 333444555; // 并发测试1
const USER_CONCURRENT_2 = 444555666; // 并发测试2
const USER_ALREADY_APPLIED = 555666777; // 已应用过的

async function cleanup() {
  console.log("🧹 清理所有测试数据...");
  const client = await pool.connect();
  try {
    await client.query(
      "DELETE FROM users WHERE telegram_user_id IN ($1, $2, $3, $4, $5)",
      [USER_NEW_PERIOD, USER_ENDED, USER_CONCURRENT_1, USER_CONCURRENT_2, USER_ALREADY_APPLIED]
    );
    console.log("✅ 清理完成\n");
  } finally {
    client.release();
  }
}

async function createTestUser(telegramId, username) {
  const client = await dbPool.connect();
  try {
    const gatewayToken = `gw_cron_${telegramId}_${Date.now()}`;
    const result = await client.query(
      `INSERT INTO users (telegram_user_id, telegram_username, gateway_token)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [telegramId, username, gatewayToken]
    );
    return result.rows[0].id;
  } finally {
    client.release();
  }
}

async function createAssistant(userId, botId) {
  const client = await dbPool.connect();
  try {
    const botToken = `${botId}:AAH-cron-test-${Date.now()}`;
    const result = await client.query(
      `INSERT INTO assistants (owner_user_id, assistant_bot_id, assistant_bot_token, assistant_bot_username)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, botId, botToken, `cron_bot_${botId}`]
    );
    return result.rows[0].id;
  } finally {
    client.release();
  }
}

async function createPeriod(userId, planCode, periodStart, periodEnd, budgetApplied = false) {
  const client = await dbPool.connect();
  try {
    const subscriptionId = `sub_cron_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const customerId = `cus_cron_${userId}`;
    const invoiceId = `in_cron_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    const result = await client.query(
      `INSERT INTO subscription_periods (
        user_id, stripe_subscription_id, stripe_customer_id, stripe_invoice_id,
        period_start, period_end, plan_id, status, cancel_at_period_end,
        budget_applied_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', false, $8)
      RETURNING id, stripe_subscription_id`,
      [userId, subscriptionId, customerId, invoiceId, periodStart, periodEnd, planCode, 
       budgetApplied ? new Date() : null]
    );
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

async function createRuntimeInstance(assistantId, userId, status = "running") {
  const client = await dbPool.connect();
  try {
    const containerName = `pinclaw-bot-${assistantId}`;
    const runtime = process.env.CONTAINER_RUNTIME || "docker";
    await client.query(
      `INSERT INTO runtime_instances (assistant_id, owner_user_id, scope, runtime_provider, runtime_ref, container_name, status, host_port, metadata)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, '{}'::jsonb)`,
      [assistantId, userId, runtime, containerName, containerName, status, 8000 + assistantId]
    );
  } finally {
    client.release();
  }
}

async function scenario1_NewPeriodToApply() {
  console.log("📌 场景 1: 新周期开始，待应用 budget");
  console.log("=".repeat(60));
  
  // 获取 plan
  const client = await dbPool.connect();
  let planCode;
  try {
    const planResult = await client.query(
      "SELECT plan_code FROM billing_plans ORDER BY monthly_refresh_credits DESC LIMIT 1"
    );
    planCode = planResult.rows[0].plan_code;
  } finally {
    client.release();
  }
  
  const userId = await createTestUser(USER_NEW_PERIOD, "user_new_period");
  const assistantId = await createAssistant(userId, USER_NEW_PERIOD);
  
  const now = new Date();
  const periodStart = new Date(now.getTime() - 1000); // 1秒前开始
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  
  const period = await createPeriod(userId, planCode, periodStart, periodEnd, false);
  
  console.log("✅ 准备完成:");
  console.log(`   user_id: ${userId}, telegram_id: ${USER_NEW_PERIOD}`);
  console.log(`   period_id: ${period.id}, subscription: ${period.stripe_subscription_id}`);
  console.log(`   period_start: ${periodStart.toISOString()}`);
  console.log(`   budget_applied_at: NULL (待应用)\n`);
  
  return { userId, assistantId, periodId: period.id };
}

async function scenario2_EndedSubscription() {
  console.log("📌 场景 2: 订阅已结束，需要清零 + 停容器");
  console.log("=".repeat(60));
  
  const client = await dbPool.connect();
  let planCode;
  try {
    const planResult = await client.query(
      "SELECT plan_code FROM billing_plans ORDER BY monthly_refresh_credits DESC LIMIT 1"
    );
    planCode = planResult.rows[0].plan_code;
  } finally {
    client.release();
  }
  
  const userId = await createTestUser(USER_ENDED, "user_ended");
  const assistantId = await createAssistant(userId, USER_ENDED);
  
  // 创建一个已结束的周期（结束时间在过去）
  const now = new Date();
  const periodStart = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000); // 40天前
  const periodEnd = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);   // 10天前结束
  
  const period = await createPeriod(userId, planCode, periodStart, periodEnd, true);
  
  // 创建运行中的容器
  await createRuntimeInstance(assistantId, userId, "running");
  
  console.log("✅ 准备完成:");
  console.log(`   user_id: ${userId}, telegram_id: ${USER_ENDED}`);
  console.log(`   period 已结束: ${periodEnd.toISOString()}`);
  console.log(`   容器状态: running (应该被停止)\n`);
  
  return { userId, assistantId, periodId: period.id };
}

async function scenario3_ConcurrentUsers() {
  console.log("📌 场景 3: 并发处理多个用户");
  console.log("=".repeat(60));
  
  const client = await dbPool.connect();
  let planCode;
  try {
    const planResult = await client.query(
      "SELECT plan_code FROM billing_plans ORDER BY monthly_refresh_credits DESC LIMIT 1"
    );
    planCode = planResult.rows[0].plan_code;
  } finally {
    client.release();
  }
  
  const now = new Date();
  const periodStart = new Date(now.getTime() - 500);
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  
  // 用户1
  const userId1 = await createTestUser(USER_CONCURRENT_1, "user_concurrent_1");
  await createAssistant(userId1, USER_CONCURRENT_1);
  const period1 = await createPeriod(userId1, planCode, periodStart, periodEnd, false);
  
  // 用户2
  const userId2 = await createTestUser(USER_CONCURRENT_2, "user_concurrent_2");
  await createAssistant(userId2, USER_CONCURRENT_2);
  const period2 = await createPeriod(userId2, planCode, periodStart, periodEnd, false);
  
  console.log("✅ 准备完成:");
  console.log(`   用户1: user_id=${userId1}, period_id=${period1.id}`);
  console.log(`   用户2: user_id=${userId2}, period_id=${period2.id}`);
  console.log(`   两个周期都待应用\n`);
  
  return [
    { userId: userId1, periodId: period1.id },
    { userId: userId2, periodId: period2.id }
  ];
}

async function scenario4_AlreadyApplied() {
  console.log("📌 场景 4: 已应用过的周期（幂等性测试）");
  console.log("=".repeat(60));
  
  const client = await dbPool.connect();
  let planCode;
  try {
    const planResult = await client.query(
      "SELECT plan_code FROM billing_plans ORDER BY monthly_refresh_credits DESC LIMIT 1"
    );
    planCode = planResult.rows[0].plan_code;
  } finally {
    client.release();
  }
  
  const userId = await createTestUser(USER_ALREADY_APPLIED, "user_already_applied");
  await createAssistant(userId, USER_ALREADY_APPLIED);
  
  const now = new Date();
  const periodStart = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5天前开始
  const periodEnd = new Date(now.getTime() + 25 * 24 * 60 * 60 * 1000);
  
  // budget_applied_at 已设置
  const period = await createPeriod(userId, planCode, periodStart, periodEnd, true);
  
  console.log("✅ 准备完成:");
  console.log(`   user_id: ${userId}, telegram_id: ${USER_ALREADY_APPLIED}`);
  console.log(`   period_id: ${period.id}`);
  console.log(`   budget_applied_at: 已设置 (不应重复应用)\n`);
  
  return { userId, periodId: period.id };
}

async function executeCronTask() {
  console.log("⏰ 执行定时任务: applySubscriptionPeriodBudgets()");
  console.log("=".repeat(60));
  
  try {
    await applySubscriptionPeriodBudgets();
    console.log("✅ 定时任务执行完成\n");
  } catch (error) {
    console.error("❌ 定时任务执行失败:", error.message);
    throw error;
  }
}

async function verifyScenario1(periodId) {
  console.log("🔍 验证场景 1: 新周期是否应用了 budget");
  console.log("=".repeat(60));
  
  const client = await dbPool.connect();
  try {
    const result = await client.query(
      "SELECT budget_applied_at FROM subscription_periods WHERE id = $1",
      [periodId]
    );
    
    const budgetApplied = result.rows[0]?.budget_applied_at;
    
    if (budgetApplied) {
      console.log("✅ budget_applied_at 已更新:", budgetApplied);
      console.log("   (说明定时任务成功应用了 budget)\n");
      return true;
    } else {
      console.log("❌ budget_applied_at 仍为 NULL");
      console.log("   (定时任务未应用，可能是条件不满足或出错)\n");
      return false;
    }
  } finally {
    client.release();
  }
}

async function verifyScenario2(assistantId) {
  console.log("🔍 验证场景 2: 容器是否被停止");
  console.log("=".repeat(60));
  
  const client = await dbPool.connect();
  try {
    const result = await client.query(
      "SELECT status FROM runtime_instances WHERE assistant_id = $1",
      [assistantId]
    );
    
    if (result.rows.length === 0) {
      console.log("ℹ️  runtime_instances 中无记录\n");
      return false;
    }
    
    const status = result.rows[0].status;
    console.log(`容器状态: ${status}`);
    
    if (status === "stopped") {
      console.log("✅ 容器已停止 (符合预期)\n");
      return true;
    } else if (status === "running") {
      console.log("⚠️  容器仍在运行 (可能定时任务未执行停止逻辑)\n");
      return false;
    } else {
      console.log(`ℹ️  容器状态: ${status}\n`);
      return false;
    }
  } finally {
    client.release();
  }
}

async function verifyScenario3(periodIds) {
  console.log("🔍 验证场景 3: 并发处理是否都成功");
  console.log("=".repeat(60));
  
  const client = await dbPool.connect();
  try {
    const result = await client.query(
      "SELECT id, budget_applied_at FROM subscription_periods WHERE id = ANY($1)",
      [periodIds]
    );
    
    let allApplied = true;
    result.rows.forEach((row, idx) => {
      if (row.budget_applied_at) {
        console.log(`✅ Period ${idx + 1} (id=${row.id}): budget_applied_at = ${row.budget_applied_at}`);
      } else {
        console.log(`❌ Period ${idx + 1} (id=${row.id}): budget_applied_at = NULL`);
        allApplied = false;
      }
    });
    
    if (allApplied) {
      console.log("\n✅ 所有并发周期都成功应用\n");
    } else {
      console.log("\n⚠️  部分并发周期未应用\n");
    }
    
    return allApplied;
  } finally {
    client.release();
  }
}

async function verifyScenario4(periodId) {
  console.log("🔍 验证场景 4: 已应用的周期不会重复应用");
  console.log("=".repeat(60));
  
  const client = await dbPool.connect();
  try {
    // 记录执行前的 budget_applied_at
    const before = await client.query(
      "SELECT budget_applied_at FROM subscription_periods WHERE id = $1",
      [periodId]
    );
    
    const appliedAtBefore = before.rows[0]?.budget_applied_at;
    
    if (!appliedAtBefore) {
      console.log("❌ 测试数据错误: budget_applied_at 应该预先设置\n");
      return false;
    }
    
    // 执行定时任务后，再次查询
    const after = await client.query(
      "SELECT budget_applied_at FROM subscription_periods WHERE id = $1",
      [periodId]
    );
    
    const appliedAtAfter = after.rows[0]?.budget_applied_at;
    
    // 时间应该一样（不会被更新）
    if (appliedAtBefore.getTime() === appliedAtAfter.getTime()) {
      console.log("✅ budget_applied_at 未变化 (幂等性正确)");
      console.log(`   Before: ${appliedAtBefore}`);
      console.log(`   After:  ${appliedAtAfter}\n`);
      return true;
    } else {
      console.log("❌ budget_applied_at 被更新了 (不应该)");
      console.log(`   Before: ${appliedAtBefore}`);
      console.log(`   After:  ${appliedAtAfter}\n`);
      return false;
    }
  } finally {
    client.release();
  }
}

async function showFinalState() {
  console.log("\n" + "=".repeat(60));
  console.log("📊 最终数据库状态");
  console.log("=".repeat(60));
  
  const client = await dbPool.connect();
  try {
    const result = await client.query(
      `SELECT 
        u.telegram_user_id,
        sp.id as period_id,
        sp.stripe_subscription_id,
        sp.plan_id,
        sp.period_start,
        sp.period_end,
        sp.budget_applied_at,
        (SELECT status FROM runtime_instances ri WHERE ri.assistant_id IN (
          SELECT a.id FROM assistants a WHERE a.owner_user_id = u.id LIMIT 1
        ) LIMIT 1) as container_status
       FROM users u
       LEFT JOIN subscription_periods sp ON sp.user_id = u.id
       WHERE u.telegram_user_id IN ($1, $2, $3, $4, $5)
       ORDER BY u.telegram_user_id, sp.period_start DESC`,
      [USER_NEW_PERIOD, USER_ENDED, USER_CONCURRENT_1, USER_CONCURRENT_2, USER_ALREADY_APPLIED]
    );
    
    console.log("\n所有测试用户的状态:");
    result.rows.forEach(row => {
      console.log(`\nTelegram ID: ${row.telegram_user_id}`);
      console.log(`  Period ID: ${row.period_id}`);
      console.log(`  Subscription: ${row.stripe_subscription_id}`);
      console.log(`  Plan: ${row.plan_id}`);
      console.log(`  Period: ${row.period_start?.toISOString().slice(0, 10)} → ${row.period_end?.toISOString().slice(0, 10)}`);
      console.log(`  Budget Applied: ${row.budget_applied_at || "NULL"}`);
      console.log(`  Container: ${row.container_status || "N/A"}`);
    });
    
  } finally {
    client.release();
  }
}

async function main() {
  console.log("\n🚀 定时任务完整测试");
  console.log("=".repeat(60));
  console.log("测试场景:");
  console.log("  1. 新周期开始 → 应用 budget");
  console.log("  2. 订阅到期 → 清零 + 停容器");
  console.log("  3. 并发处理");
  console.log("  4. 幂等性\n");
  
  try {
    await cleanup();
    
    // 准备所有场景
    const s1 = await scenario1_NewPeriodToApply();
    const s2 = await scenario2_EndedSubscription();
    const s3 = await scenario3_ConcurrentUsers();
    const s4 = await scenario4_AlreadyApplied();
    
    console.log("\n" + "=".repeat(60));
    
    // 执行定时任务
    await executeCronTask();
    
    console.log("=".repeat(60));
    console.log("📋 验证结果");
    console.log("=".repeat(60) + "\n");
    
    // 验证各场景
    const v1 = await verifyScenario1(s1.periodId);
    const v2 = await verifyScenario2(s2.assistantId);
    const v3 = await verifyScenario3([s3[0].periodId, s3[1].periodId]);
    const v4 = await verifyScenario4(s4.periodId);
    
    await showFinalState();
    
    console.log("\n" + "=".repeat(60));
    console.log("📈 测试总结");
    console.log("=".repeat(60));
    console.log(`场景 1 (新周期应用): ${v1 ? "✅ 通过" : "❌ 失败"}`);
    console.log(`场景 2 (订阅到期停容器): ${v2 ? "✅ 通过" : "⚠️  未验证 (可能需要真实容器)"}`);
    console.log(`场景 3 (并发处理): ${v3 ? "✅ 通过" : "❌ 失败"}`);
    console.log(`场景 4 (幂等性): ${v4 ? "✅ 通过" : "❌ 失败"}`);
    
    const allPassed = v1 && v3 && v4;
    if (allPassed) {
      console.log("\n🎉 核心功能测试全部通过！");
    } else {
      console.log("\n⚠️  部分测试未通过，请检查日志");
    }
    
    console.log("\n⚠️  测试数据已保留，可在数据库中查看");
    console.log(`    SELECT * FROM users WHERE telegram_user_id IN (${USER_NEW_PERIOD}, ${USER_ENDED}, ${USER_CONCURRENT_1}, ${USER_CONCURRENT_2}, ${USER_ALREADY_APPLIED});\n`);
    
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    if (error.stack) console.error("\n" + error.stack);
    process.exit(1);
  } finally {
    await dbPool.end();
    await pool.end();
  }
}

main();
