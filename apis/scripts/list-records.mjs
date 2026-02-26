#!/usr/bin/env node
/**
 * 列出当前数据库中的用户、助理及运行时记录（只读）。
 *
 * 用法（在 apis 目录下）:
 *   SUPABASE_DB_URL=postgresql://... node scripts/list-records.mjs
 */

import pg from 'pg';

const { Pool } = pg;

const dbUrl = (process.env.SUPABASE_DB_URL || '').trim();
if (!dbUrl) {
  console.error('请设置环境变量 SUPABASE_DB_URL');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const users = await pool.query(
      `SELECT id, telegram_user_id, telegram_username, created_at
       FROM users
       ORDER BY id`
    );
    console.log('--- users ---');
    console.log(`共 ${users.rows.length} 条`);
    if (users.rows.length) {
      console.table(users.rows);
    }

    const assistants = await pool.query(
      `SELECT a.id, a.owner_user_id, u.telegram_user_id AS owner_telegram_user_id,
              a.assistant_bot_id, a.assistant_bot_username, a.created_at,
              r.status AS runtime_status, r.container_name
       FROM assistants a
       JOIN users u ON u.id = a.owner_user_id
       LEFT JOIN runtime_instances r ON r.assistant_id = a.id AND r.scope = 'assistant'
       ORDER BY a.created_at DESC`
    );
    console.log('\n--- assistants ---');
    console.log(`共 ${assistants.rows.length} 条`);
    if (assistants.rows.length) {
      console.table(assistants.rows);
    }

    const runtimes = await pool.query(
      `SELECT id, owner_user_id, assistant_id, scope, runtime_provider,
              container_name, status, created_at
       FROM runtime_instances
       ORDER BY id`
    );
    console.log('\n--- runtime_instances ---');
    console.log(`共 ${runtimes.rows.length} 条`);
    if (runtimes.rows.length) {
      console.table(runtimes.rows);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
