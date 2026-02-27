#!/usr/bin/env node
/**
 * 以 LiteLLM 表为准，直接按订阅计划更新 LiteLLM 的 budget。
 * 用法：cd apis && node scripts/update-budget-sql.mjs
 * 不再更新 users.litellm_budget_usd，以 LiteLLM_UserTable 为唯一数据源。
 */

import dotenv from 'dotenv';
import pg from 'pg';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

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

const dbUrl = (process.env.SUPABASE_DB_URL || process.env.LITELLM_SUPABASE_DB_URL || '').trim();
if (!dbUrl) {
  console.error('请设置 SUPABASE_DB_URL 或 LITELLM_SUPABASE_DB_URL');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  try {
    // 按订阅计划计算 budget，直接写入 LiteLLM 表
    const planBudget = `
      SELECT u.id, u.telegram_user_id, u.litellm_user_id, u.litellm_user_alias,
             LEAST(999999, GREATEST(0, (bp.monthly_refresh_credits::numeric / 100)::numeric(18,6))) AS budget_usd
      FROM user_subscriptions us
      JOIN billing_plans bp ON bp.plan_code = us.plan_id
      JOIN users u ON u.id = us.user_id
      WHERE us.status IN ('active', 'trialing', 'past_due')
        AND us.plan_id IS NOT NULL
    `;

    const userResult = await client.query(`
      INSERT INTO "LiteLLM_UserTable" (user_id, user_alias, max_budget, spend, models, metadata)
      SELECT COALESCE(NULLIF(TRIM(src.litellm_user_id), ''), src.id::text),
             COALESCE(NULLIF(TRIM(src.litellm_user_alias), ''), 'telegram:' || src.telegram_user_id),
             src.budget_usd, 0, '{}'::text[], '{}'::jsonb
      FROM (${planBudget}) src
      ON CONFLICT (user_id) DO UPDATE SET
        max_budget = EXCLUDED.max_budget,
        updated_at = NOW()
      RETURNING user_id, max_budget
    `);
    console.log('Updated LiteLLM_UserTable:', userResult.rowCount ?? 0);
    for (const row of userResult.rows || []) {
      console.log(`  - user_id=${row.user_id}, max_budget=${row.max_budget}`);
    }

    const litellmKeyResult = await client.query(`
      UPDATE "LiteLLM_VerificationToken" v
      SET max_budget = src.budget_usd,
          updated_at = NOW()
      FROM (${planBudget}) src
      WHERE v.user_id = COALESCE(NULLIF(TRIM(src.litellm_user_id), ''), src.id::text)
      RETURNING v.user_id, v.key_alias, v.max_budget
    `);
    console.log('Updated LiteLLM_VerificationToken:', litellmKeyResult.rowCount);

    console.log('\n✅ LiteLLM 表已更新（以订阅计划为准）');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
