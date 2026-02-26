#!/usr/bin/env node

import pg from 'pg';

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
      console.log(JSON.stringify({
        id: row.id,
        telegram_user_id: row.telegram_user_id,
        stripe_subscription_id: row.stripe_subscription_id,
        status: row.status,
        stripe_status: row.stripe_status,
        plan_id: row.plan_id,
        created_at: row.created_at,
      }, null, 2));
      console.log('---');
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkRecentSubscriptions();
