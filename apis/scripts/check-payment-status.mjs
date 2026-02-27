#!/usr/bin/env node
/**
 * 检查支付和容器状态
 * 用法：cd apis && node scripts/check-payment-status.mjs
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apisRoot = resolve(__dirname, '..');
const repoRoot = resolve(apisRoot, '..');

for (const p of [
  resolve(repoRoot, '.env'),
  resolve(repoRoot, '.env.local'),
  resolve(apisRoot, '.env'),
  resolve(apisRoot, '.env.local'),
]) {
  if (existsSync(p)) {
    dotenv.config({ path: p, override: false });
    break;
  }
}

const dbUrl = (process.env.SUPABASE_DB_URL || '').trim();
if (!dbUrl) {
  console.error('请设置 SUPABASE_DB_URL');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: dbUrl });

async function main() {
  const client = await pool.connect();
  try {
    console.log('\n=== user_subscriptions ===');
    const subs = await client.query(`
      SELECT u.telegram_user_id, us.status, us.stripe_subscription_id, us.plan_id, us.last_stripe_event_id, us.updated_at
      FROM user_subscriptions us
      JOIN users u ON u.id = us.user_id
      ORDER BY us.updated_at DESC
      LIMIT 5
    `);
    console.table(subs.rows);

    console.log('\n=== payment_events (最近 10 条) ===');
    const events = await client.query(`
      SELECT stripe_event_id, event_type, processing_status, error_message, created_at
      FROM payment_events
      ORDER BY created_at DESC
      LIMIT 10
    `);
    console.table(events.rows);

    console.log('\n=== runtime_instances (assistant) ===');
    const runtimes = await client.query(`
      SELECT ri.id, ri.assistant_id, ri.scope, ri.status, ri.runtime_ref, ri.created_at
      FROM runtime_instances ri
      WHERE ri.scope = 'assistant'
      ORDER BY ri.created_at DESC
    `);
    console.table(runtimes.rows);

    console.log('\n=== assistants + container_status ===');
    const assistants = await client.query(`
      SELECT a.id, a.assistant_bot_id, a.assistant_bot_username, o.telegram_user_id,
             COALESCE(ri.status, 'no_runtime') AS container_status
      FROM assistants a
      JOIN users o ON o.id = a.owner_user_id
      LEFT JOIN runtime_instances ri ON ri.assistant_id = a.id AND ri.scope = 'assistant'
      ORDER BY a.id DESC
    `);
    console.table(assistants.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
