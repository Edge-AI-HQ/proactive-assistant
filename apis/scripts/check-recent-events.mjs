import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const result = await pool.query(`
    SELECT 
      id,
      stripe_event_id,
      event_type,
      user_id,
      assistant_id,
      telegram_user_id,
      created_at
    FROM payment_events
    WHERE created_at > NOW() - INTERVAL '3 hours'
    ORDER BY created_at DESC
    LIMIT 30
  `);

  console.log(`\n📊 Found ${result.rows.length} recent payment events:\n`);
  
  const noUserId = result.rows.filter(r => !r.user_id);
  const withUserId = result.rows.filter(r => r.user_id);
  
  console.log(`✅ With user_id: ${withUserId.length}`);
  console.log(`❌ Without user_id: ${noUserId.length}\n`);
  
  if (noUserId.length > 0) {
    console.log('❌ Events without user_id:');
    noUserId.forEach(row => {
      console.log(`  - ${row.event_type} (${row.created_at.toISOString()}) telegram_user_id=${row.telegram_user_id || 'NULL'}`);
    });
  }
  
  console.log('\n📝 All events:');
  result.rows.forEach(row => {
    console.log(`  ${row.created_at.toISOString()} | ${row.event_type.padEnd(35)} | user_id=${String(row.user_id || 'NULL').padEnd(5)} | assistant_id=${String(row.assistant_id || 'NULL').padEnd(5)} | telegram=${row.telegram_user_id || 'NULL'}`);
  });

  await pool.end();
} catch (error) {
  console.error('Error:', error);
  process.exit(1);
}
