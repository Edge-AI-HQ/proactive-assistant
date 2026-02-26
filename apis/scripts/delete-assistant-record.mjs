#!/usr/bin/env node
/**
 * 删除助理创建记录（有记录但未支付、容器未创建时可用于清理）。
 * 会同时删除关联的 runtime_instances（数据库 CASCADE）。
 *
 * 用法（在 apis 目录下，需先设置 SUPABASE_DB_URL）:
 *   # 按助理 ID 删除
 *   ASSISTANT_ID=123 node scripts/delete-assistant-record.mjs
 *
 *   # 按 Telegram 用户 ID 删除该用户「最近创建」的一条助理记录
 *   TELEGRAM_USER_ID=456789 node scripts/delete-assistant-record.mjs
 */

import pg from 'pg';

const { Pool } = pg;

const dbUrl = (process.env.SUPABASE_DB_URL || '').trim();
if (!dbUrl) {
  console.error('请设置环境变量 SUPABASE_DB_URL');
  process.exit(1);
}

const assistantIdRaw = process.env.ASSISTANT_ID?.trim();
const telegramUserIdRaw = process.env.TELEGRAM_USER_ID?.trim();

const assistantId = assistantIdRaw ? parseInt(assistantIdRaw, 10) : null;
const telegramUserId = telegramUserIdRaw ? parseInt(telegramUserIdRaw, 10) : null;

if (assistantId && telegramUserId) {
  console.error('请只设置 ASSISTANT_ID 或 TELEGRAM_USER_ID 其一');
  process.exit(1);
}
if (!assistantId && !telegramUserId) {
  console.error('请设置 ASSISTANT_ID 或 TELEGRAM_USER_ID');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: dbUrl });
  let targetId = assistantId;

  try {
    if (telegramUserId) {
      const userRow = await pool.query(
        'SELECT id FROM users WHERE telegram_user_id = $1',
        [telegramUserId]
      );
      if (userRow.rows.length === 0) {
        console.error(`未找到 telegram_user_id=${telegramUserId} 的用户`);
        process.exit(1);
      }
      const ownerUserId = userRow.rows[0].id;
      const assistRow = await pool.query(
        `SELECT id, assistant_bot_id, created_at
         FROM assistants
         WHERE owner_user_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [ownerUserId]
      );
      if (assistRow.rows.length === 0) {
        console.error(`该用户下没有助理记录`);
        process.exit(1);
      }
      targetId = assistRow.rows[0].id;
      console.log(
        `找到最近一条助理记录: id=${targetId}, assistant_bot_id=${assistRow.rows[0].assistant_bot_id}, created_at=${assistRow.rows[0].created_at}`
      );
    }

    const del = await pool.query('DELETE FROM assistants WHERE id = $1 RETURNING id', [
      targetId,
    ]);
    if (del.rowCount === 0) {
      console.error(`未找到 assistant id=${targetId}`);
      process.exit(1);
    }
    console.log(`已删除助理记录 id=${targetId}（关联的 runtime_instances 已级联删除）。`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
