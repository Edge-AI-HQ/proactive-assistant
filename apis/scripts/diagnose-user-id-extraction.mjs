// 诊断为什么最近的 payment events 没有 user_id
// 用法: flyctl ssh console -a pinclaw-api-dev -C "node /app/apis/dist/../scripts/diagnose-user-id-extraction.mjs"

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function diagnose() {
  // 1. 查询最近没有 user_id 的事件
  const eventsWithoutUserId = await pool.query(`
    SELECT 
      id,
      stripe_event_id,
      event_type,
      telegram_user_id,
      assistant_id,
      raw_data,
      created_at
    FROM payment_events
    WHERE user_id IS NULL
      AND created_at > NOW() - INTERVAL '6 hours'
    ORDER BY created_at DESC
    LIMIT 5
  `);

  console.log(`\n📊 Found ${eventsWithoutUserId.rows.length} events without user_id in last 6 hours\n`);

  for (const event of eventsWithoutUserId.rows) {
    console.log(`\n========================================`);
    console.log(`Event: ${event.event_type}`);
    console.log(`Stripe Event ID: ${event.stripe_event_id}`);
    console.log(`Created: ${event.created_at.toISOString()}`);
    console.log(`telegram_user_id in DB: ${event.telegram_user_id || 'NULL'}`);
    console.log(`assistant_id in DB: ${event.assistant_id || 'NULL'}`);
    
    // 检查 raw_data 中的 metadata
    const rawData = event.raw_data;
    if (rawData && typeof rawData === 'object') {
      console.log(`\nRaw data metadata:`);
      console.log(`  - metadata.telegram_user_id: ${rawData.metadata?.telegram_user_id || 'NULL'}`);
      console.log(`  - metadata.assistant_id: ${rawData.metadata?.assistant_id || 'NULL'}`);
      
      // 对于 invoice
      if (event.event_type.includes('invoice')) {
        console.log(`\nInvoice specific:`);
        console.log(`  - subscription (parent): ${rawData.subscription || 'NULL'}`);
        console.log(`  - parent.subscription_details.metadata.telegram_user_id: ${rawData.parent?.subscription_details?.metadata?.telegram_user_id || 'NULL'}`);
        console.log(`  - lines[0].metadata.telegram_user_id: ${rawData.lines?.data?.[0]?.metadata?.telegram_user_id || 'NULL'}`);
        console.log(`  - lines count: ${rawData.lines?.data?.length || 0}`);
      }
      
      // 对于 subscription
      if (event.event_type.includes('subscription')) {
        console.log(`\nSubscription specific:`);
        console.log(`  - id: ${rawData.id || 'NULL'}`);
        console.log(`  - customer: ${rawData.customer || 'NULL'}`);
      }
    }
  }

  // 2. 统计最近事件的 user_id 情况
  const stats = await pool.query(`
    SELECT 
      event_type,
      COUNT(*) as total,
      COUNT(user_id) as with_user_id,
      COUNT(*) - COUNT(user_id) as without_user_id
    FROM payment_events
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY event_type
    ORDER BY total DESC
  `);

  console.log(`\n\n📈 Last 24 hours statistics:\n`);
  console.log(`Event Type                          | Total | With user_id | Without`);
  console.log(`------------------------------------|-------|--------------|--------`);
  stats.rows.forEach(row => {
    console.log(`${row.event_type.padEnd(35)} | ${String(row.total).padStart(5)} | ${String(row.with_user_id).padStart(12)} | ${String(row.without_user_id).padStart(7)}`);
  });

  await pool.end();
}

diagnose().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
