#!/usr/bin/env node
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DB_URL,
});

async function main() {
  try {
    // 1. 检查 assistants 表结构
    console.log("📋 assistants 表结构:");
    const assistantSchema = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'assistants'
      ORDER BY ordinal_position
    `);
    console.table(assistantSchema.rows);
    console.log();

    // 2. 检查最近的 assistants
    console.log("🤖 最近的 assistants:");
    const assistants = await pool.query(`
      SELECT * FROM assistants 
      ORDER BY created_at DESC 
      LIMIT 5
    `);
    console.table(assistants.rows);
    console.log();

    // 3. 检查你的用户 ID 对应的 assistant
    console.log("👤 telegram_user_id=5572561504 的 assistant:");
    const myAssistant = await pool.query(`
      SELECT a.*, u.telegram_user_id
      FROM assistants a
      JOIN users u ON u.id = a.owner_user_id
      WHERE u.telegram_user_id = '5572561504'
    `);
    console.table(myAssistant.rows);
    console.log();

    // 4. 检查 payment_session
    console.log("💳 telegram_user_id=5572561504 的 payment_sessions:");
    const myPaymentSessions = await pool.query(`
      SELECT ps.*, u.telegram_user_id
      FROM payment_sessions ps
      JOIN users u ON u.id = ps.user_id
      WHERE u.telegram_user_id = '5572561504'
      ORDER BY ps.created_at DESC
    `);
    console.table(myPaymentSessions.rows);

  } catch (error) {
    console.error("❌ 错误:", error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
