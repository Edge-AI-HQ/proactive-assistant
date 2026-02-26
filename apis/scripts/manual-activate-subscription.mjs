#!/usr/bin/env node
/**
 * 手动激活订阅并触发容器启动（临时方案，用于测试支付后通知功能）
 * 用法：SUPABASE_DB_URL=... node scripts/manual-activate-subscription.mjs
 */

import pg from 'pg';
import fetch from 'node-fetch';

const { Pool } = pg;

const dbUrl = (process.env.SUPABASE_DB_URL || '').trim();
const apiBaseUrl = (process.env.API_BASE_URL || 'https://pinclaw-api-dev.fly.dev').trim();
const apiToken = (process.env.API_INTERNAL_TOKEN || '').trim();

if (!dbUrl) {
  console.error('请设置环境变量 SUPABASE_DB_URL');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    // 找到最新的 pending 订阅
    const subRes = await pool.query(
      `SELECT s.id, s.user_id, u.telegram_user_id, s.stripe_subscription_id, s.plan_id
       FROM user_subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'pending'
       ORDER BY s.created_at DESC
       LIMIT 1`
    );
    if (subRes.rows.length === 0) {
      console.log('没有找到 pending 状态的订阅');
      process.exit(0);
    }

    const sub = subRes.rows[0];
    console.log('找到订阅:', sub);

    // 手动改为 active
    await pool.query(
      `UPDATE user_subscriptions
       SET status = 'active',
           current_period_start = NOW(),
           current_period_end = NOW() + interval '1 month',
           updated_at = NOW()
       WHERE id = $1`,
      [sub.id]
    );
    console.log(`已将订阅 ${sub.id} 改为 active`);

    // 调用内部接口触发容器启动（模拟 syncSubscriptionFromStripe）
    // 由于我们无法直接调内部函数，这里通过创建一个临时脚本来模拟
    // 更简单的方式：直接在这里启动容器并发通知

    const userRes = await pool.query(
      'SELECT telegram_user_id, gateway_token FROM users WHERE id = $1',
      [sub.user_id]
    );
    if (userRes.rows.length === 0) {
      console.error('未找到用户');
      process.exit(1);
    }
    const user = userRes.rows[0];

    const assistantsRes = await pool.query(
      `SELECT a.id, a.assistant_bot_username,
              COALESCE(r.status, 'stopped') as container_status
       FROM assistants a
       LEFT JOIN runtime_instances r ON r.assistant_id = a.id
       WHERE a.owner_user_id = $1`,
      [sub.user_id]
    );

    console.log(`找到 ${assistantsRes.rows.length} 个助理`);

    const stoppedAssistants = assistantsRes.rows.filter(
      a => a.container_status === 'stopped' || a.container_status === 'pending'
    );

    if (stoppedAssistants.length === 0) {
      console.log('没有需要启动的容器');
      process.exit(0);
    }

    console.log(`准备启动 ${stoppedAssistants.length} 个容器...`);

    for (const assistant of stoppedAssistants) {
      try {
        const url = `${apiBaseUrl}/api/container/assistant/${assistant.id}/create`;
        console.log(`调用 ${url}`);
        
        const headers = { 'Content-Type': 'application/json' };
        if (apiToken) {
          headers['x-api-key'] = apiToken;
        }

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({})
        });

        if (res.ok) {
          console.log(`✅ 容器 ${assistant.id} 启动成功`);
        } else {
          const text = await res.text();
          console.error(`❌ 容器 ${assistant.id} 启动失败: ${res.status} ${text}`);
        }
      } catch (err) {
        console.error(`容器 ${assistant.id} 启动异常:`, err.message);
      }
    }

    // 发 Telegram 通知
    console.log('\n准备发送 Telegram 通知...');
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!botToken) {
      console.warn('⚠️  TELEGRAM_BOT_TOKEN 未设置，跳过通知');
    } else {
      const botnames = stoppedAssistants
        .map(a => a.assistant_bot_username ? `@${a.assistant_bot_username}` : `#${a.id}`)
        .join(', ');

      const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      try {
        const res = await fetch(telegramUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: user.telegram_user_id,
            text: `✅ <b>Container(s) ready</b>\n\nYour assistant bot(s) are now running: ${botnames}\n\nYou can open the Gateway link from the guide bot to start chatting.`,
            parse_mode: 'HTML'
          })
        });

        const data = await res.json();
        if (res.ok && data.ok) {
          console.log('✅ Telegram 通知已发送');
        } else {
          console.error(`❌ Telegram 通知失败: ${data.description || res.status}`);
        }
      } catch (err) {
        console.error('Telegram 通知异常:', err.message);
      }
    }

    console.log('\n✅ 完成');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
