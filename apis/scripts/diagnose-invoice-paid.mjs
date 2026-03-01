#!/usr/bin/env node
/**
 * 诊断 invoice.paid 处理逻辑
 * 逐步执行 handleInvoicePaid 的每个步骤，找出问题所在
 */

import "dotenv/config";
import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_URL;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

if (!DB_URL || !STRIPE_KEY) {
  console.error("❌ 缺少环境变量");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL });

const eventId = process.argv[2] || 'evt_1T698O0RaPkgaisIioHMSvXt';

console.log(`\n🔍 诊断 invoice.paid 处理: ${eventId}\n`);

try {
  // 1. 获取事件数据
  const eventResult = await pool.query(
    'SELECT raw_data FROM payment_events WHERE stripe_event_id = $1',
    [eventId]
  );
  
  if (eventResult.rows.length === 0) {
    throw new Error(`事件 ${eventId} 不存在`);
  }
  
  const invoice = eventResult.rows[0].raw_data;
  
  console.log('步骤 1: 解析 subscription_id');
  console.log('='.repeat(60));
  
  const parentSub = invoice.parent?.subscription_details?.subscription;
  const directSub = invoice.subscription;
  const lineSub = invoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription;
  
  console.log('  parent.subscription_details.subscription:', parentSub || '(无)');
  console.log('  invoice.subscription:', directSub || '(无)');
  console.log('  lines[0].parent...subscription:', lineSub || '(无)');
  
  const subscriptionId = parentSub || directSub || lineSub;
  console.log(`\n  ✅ 解析结果: ${subscriptionId}`);
  
  if (!subscriptionId) {
    console.log('\n❌ 无法解析 subscription_id，退出');
    process.exit(1);
  }
  
  console.log('\n步骤 2: 解析 telegram_user_id');
  console.log('='.repeat(60));
  
  const parentMeta = invoice.parent?.subscription_details?.metadata;
  const lineMeta = invoice.lines?.data?.[0]?.metadata;
  const invoiceMeta = invoice.metadata;
  
  console.log('  parent.subscription_details.metadata:', JSON.stringify(parentMeta || {}).slice(0, 100));
  console.log('  lines[0].metadata:', JSON.stringify(lineMeta || {}).slice(0, 100));
  console.log('  invoice.metadata:', JSON.stringify(invoiceMeta || {}));
  
  const telegram_user_id = parentMeta?.telegram_user_id || lineMeta?.telegram_user_id || invoiceMeta?.telegram_user_id;
  const telegram_username = parentMeta?.telegram_username || lineMeta?.telegram_username || invoiceMeta?.telegram_username;
  const plan = parentMeta?.plan || lineMeta?.plan || invoiceMeta?.plan;
  
  console.log(`\n  ✅ 解析结果:`);
  console.log(`     telegram_user_id: ${telegram_user_id}`);
  console.log(`     telegram_username: ${telegram_username}`);
  console.log(`     plan: ${plan}`);
  
  if (!telegram_user_id) {
    console.log('\n❌ 无法解析 telegram_user_id，退出');
    process.exit(1);
  }
  
  console.log('\n步骤 3: 解析 period');
  console.log('='.repeat(60));
  
  const linePeriod = invoice.lines?.data?.[0]?.period;
  console.log('  lines[0].period:', linePeriod);
  
  if (linePeriod?.start && linePeriod?.end) {
    const periodStart = new Date(linePeriod.start * 1000);
    const periodEnd = new Date(linePeriod.end * 1000);
    console.log(`\n  ✅ 从 lines[0].period 解析:`);
    console.log(`     start: ${periodStart.toISOString()}`);
    console.log(`     end: ${periodEnd.toISOString()}`);
  } else {
    console.log('\n  ⚠️  lines[0].period 为空，需要查 Stripe API');
  }
  
  console.log('\n步骤 4: 验证用户是否存在');
  console.log('='.repeat(60));
  
  const userResult = await pool.query(
    'SELECT id FROM users WHERE telegram_user_id = $1',
    [Number(telegram_user_id)]
  );
  
  if (userResult.rows.length === 0) {
    console.log(`  ❌ 用户 ${telegram_user_id} 不存在于 users 表`);
    console.log('     这会导致 upsertSubscriptionPeriod 失败');
  } else {
    console.log(`  ✅ 用户存在: user_id = ${userResult.rows[0].id}`);
  }
  
  console.log('\n步骤 5: 检查是否应该写入');
  console.log('='.repeat(60));
  
  // 检查是否已有记录
  const existing = await pool.query(
    `SELECT id FROM subscription_periods 
     WHERE stripe_subscription_id = $1 
       AND period_start = to_timestamp($2)`,
    [subscriptionId, linePeriod.start]
  );
  
  if (existing.rows.length > 0) {
    console.log(`  ℹ️  已存在记录 (period_id=${existing.rows[0].id})，会执行 UPSERT 更新`);
  } else {
    console.log('  ℹ️  不存在记录，会执行 INSERT');
  }
  
  console.log('\n✅ 所有检查通过，数据应该能正常写入');
  console.log('\n如果实际没有写入，问题可能在：');
  console.log('  1. Fly 上运行的代码版本太旧');
  console.log('  2. 代码执行过程中有异常但被吞掉了');
  console.log('  3. db.upsertSubscriptionPeriod 内部失败');
  
} catch (error) {
  console.error('\n❌ 诊断失败:', error.message);
  if (error.stack) console.error(error.stack);
} finally {
  await pool.end();
}
