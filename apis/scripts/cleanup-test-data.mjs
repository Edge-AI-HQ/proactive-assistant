#!/usr/bin/env node
/**
 * 清理测试环境数据，用于重新走支付流程
 *
 * 用法：cd apis && node scripts/cleanup-test-data.mjs
 *
 * 会：
 * 1. 删除 assistant 的 runtime_instances
 * 2. 重置 assistants 的 container 状态为 pending
 * 3. 清空 payment_events
 * 4. 重置 user_subscriptions 为 pending
 * 5. 清空 user_credit_wallets 和 credit_ledger
 */

import dotenv from 'dotenv';
import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
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
    await client.query('BEGIN');

    // 1. 删除 assistant 的 runtime_instances
    const delRuntime = await client.query(
      `DELETE FROM runtime_instances WHERE scope = 'assistant'`
    );
    console.log(`✓ 删除 runtime_instances (assistant): ${delRuntime.rowCount ?? 0} 条`);

    // 2. 为每个 assistant 重新创建 runtime 记录，status=stopped，以便支付成功后触发容器创建
    const portStart = 20000;
    const portEnd = 22000;
    const used = await client.query(
      `SELECT host_port FROM runtime_instances WHERE host_port BETWEEN $1 AND $2`,
      [portStart, portEnd]
    );
    const usedSet = new Set(used.rows.map((r) => r.host_port));
    let port = portStart;
    const assistants = await client.query(
      `SELECT a.id, a.owner_user_id, a.assistant_bot_id FROM assistants a`
    );
    for (const a of assistants.rows) {
      while (usedSet.has(port)) port++;
      if (port > portEnd) {
        console.warn('⚠ 端口池已满，跳过部分 assistant');
        break;
      }
      usedSet.add(port);
      await client.query(
        `INSERT INTO runtime_instances (owner_user_id, assistant_id, scope, runtime_provider, container_name, runtime_ref, host_port, status)
         VALUES ($1, $2, 'assistant', 'fly', $3, $3, $4, 'stopped')`,
        [a.owner_user_id, a.id, `pinclaw-bot-${a.assistant_bot_id}`, port]
      );
    }
    console.log(`✓ 重建 runtime (stopped): ${assistants.rows.length} 个 assistant`);

    // 3. 清空 payment_events
    const delPayments = await client.query(`DELETE FROM payment_events`);
    console.log(`✓ 删除 payment_events: ${delPayments.rowCount ?? 0} 条`);

    // 4. 重置 user_subscriptions 为 pending
    const updSubs = await client.query(`
      UPDATE user_subscriptions
      SET
        status = 'pending',
        stripe_subscription_id = NULL,
        plan_id = NULL,
        cancel_at_period_end = FALSE,
        current_period_start = NULL,
        current_period_end = NULL,
        last_stripe_event_created = NULL,
        last_stripe_event_id = NULL,
        updated_at = NOW()
    `);
    console.log(`✓ 重置 user_subscriptions: ${updSubs.rowCount ?? 0} 条`);

    // 5. 清空 user_credit_wallets 和 credit_ledger
    const delLedger = await client.query(`DELETE FROM credit_ledger`);
    console.log(`✓ 删除 credit_ledger: ${delLedger.rowCount ?? 0} 条`);

    const delWallets = await client.query(`DELETE FROM user_credit_wallets`);
    console.log(`✓ 删除 user_credit_wallets: ${delWallets.rowCount ?? 0} 条`);

    await client.query('COMMIT');
    console.log('\n✅ 测试数据清理完成，可以重新走支付流程');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ 清理失败:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
