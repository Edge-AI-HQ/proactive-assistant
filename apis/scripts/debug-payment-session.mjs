#!/usr/bin/env node
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DB_URL,
});

async function debugPaymentSessions() {
  console.log("📊 检查 payment_sessions 表...\n");

  // 1. 检查表结构
  const schemaResult = await pool.query(`
    SELECT 
      column_name, 
      data_type, 
      is_nullable,
      column_default
    FROM information_schema.columns 
    WHERE table_name = 'payment_sessions'
    ORDER BY ordinal_position
  `);

  console.log("表结构:");
  console.table(schemaResult.rows);
  console.log();

  // 2. 检查最近的 payment sessions
  const sessionsResult = await pool.query(`
    SELECT 
      ps.id,
      ps.user_id,
      u.telegram_user_id,
      ps.assistant_id,
      ps.plan_code,
      ps.used,
      ps.expires_at,
      ps.created_at
    FROM payment_sessions ps
    LEFT JOIN users u ON u.id = ps.user_id
    ORDER BY ps.created_at DESC
    LIMIT 10
  `);

  console.log("最近 10 条 payment_sessions:");
  console.table(sessionsResult.rows);
  console.log();

  // 3. 检查没有 assistant_id 的 sessions
  const noAssistantResult = await pool.query(`
    SELECT 
      ps.id,
      u.telegram_user_id,
      ps.assistant_id,
      ps.used,
      ps.created_at
    FROM payment_sessions ps
    LEFT JOIN users u ON u.id = ps.user_id
    WHERE ps.assistant_id IS NULL
    ORDER BY ps.created_at DESC
    LIMIT 5
  `);

  console.log("没有 assistant_id 的 payment_sessions (最近5条):");
  console.table(noAssistantResult.rows);
  console.log();

  // 4. 检查 assistants 表
  const assistantsResult = await pool.query(`
    SELECT 
      a.id,
      a.owner_telegram_user_id,
      a.assistant_bot_username,
      a.container_status,
      a.created_at
    FROM assistants a
    ORDER BY a.created_at DESC
    LIMIT 10
  `);

  console.log("最近 10 个 assistants:");
  console.table(assistantsResult.rows);
  console.log();

  // 5. 检查 assistants 表字段
  const assistantSchemaResult = await pool.query(`
    SELECT 
      column_name, 
      data_type
    FROM information_schema.columns 
    WHERE table_name = 'assistants'
    ORDER BY ordinal_position
  `);

  console.log("assistants 表结构:");
  console.table(assistantSchemaResult.rows);
  console.log();

  await pool.end();
}

debugPaymentSessions().catch((err) => {
  console.error("❌ 错误:", err);
  process.exit(1);
});
