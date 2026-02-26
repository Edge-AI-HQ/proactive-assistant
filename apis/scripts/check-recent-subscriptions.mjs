#!/usr/bin/env node

import pg from 'pg';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '../..');

config({ path: resolve(rootDir, 'apis/.env.local') });

const { Pool } = pg;

async function checkRecentSubscriptions() {
  const pool = new Pool({
    connectionString: process.env.SUPABASE_DB_URL,
  });

  try {
    const result = await pool.query(`
      SELECT 
        us.id,
        us.stripe_subscription_id,
        us.status,
        us.stripe_status,
        us.plan_id,
        us.created_at,
        u.telegram_user_id
      FROM user_subscriptions us
      JOIN users u ON us.user_id = u.id
      ORDER BY us.created_at DESC
      LIMIT 5
    `);

    console.log('\n=== Recent Subscriptions ===\n');
    for (const row of result.rows) {
      console.log({
        id: row.id,
        telegram_user_id: row.telegram_user_id,
        stripe_subscription_id: row.stripe_subscription_id,
        status: row.status,
        stripe_status: row.stripe_status,
        plan_id: row.plan_id,
        created_at: row.created_at,
      });
      console.log('---');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

checkRecentSubscriptions();
