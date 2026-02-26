#!/usr/bin/env node
/**
 * 直接通过 Fly API 创建助理容器（绕过内部 HTTP API）
 * 用法：FLY_API_TOKEN=... node scripts/fly-create-container.mjs <assistant_id>
 */

import fetch from 'node-fetch';
import pg from 'pg';

const { Pool } = pg;

const dbUrl = (process.env.SUPABASE_DB_URL || '').trim();
const flyToken = (process.env.FLY_API_TOKEN || '').trim();
const flyAppName = (process.env.FLY_APP_NAME || 'pinclaw-api-dev').trim();

if (!dbUrl) {
  console.error('请设置 SUPABASE_DB_URL');
  process.exit(1);
}
if (!flyToken) {
  console.error('请设置 FLY_API_TOKEN');
  process.exit(1);
}

const assistantId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
if (!assistantId) {
  console.error('用法: node scripts/fly-create-container.mjs <assistant_id>');
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString: dbUrl });
  
  try {
    // 获取助理信息
    const assistRes = await pool.query(
      `SELECT a.id, a.assistant_bot_id, a.assistant_bot_username, a.owner_user_id,
              COALESCE(r.status, 'stopped') as container_status,
              r.id as runtime_id
       FROM assistants a
       LEFT JOIN runtime_instances r ON r.assistant_id = a.id
       WHERE a.id = $1`,
      [assistantId]
    );

    if (assistRes.rows.length === 0) {
      console.error(`助理 ${assistantId} 不存在`);
      process.exit(1);
    }

    const assistant = assistRes.rows[0];
    console.log(`助理: @${assistant.assistant_bot_username} (状态: ${assistant.container_status})`);

    if (assistant.container_status === 'running') {
      console.log('容器已在运行');
      process.exit(0);
    }

    // 通过 Fly API 创建 machine
    const machineName = \`pinclaw-bot-\${assistant.assistant_bot_id}\`;
    console.log(\`正在创建 Fly machine: \${machineName}...\`);

    // 这里只是演示，实际需要更多配置（镜像、环境变量等）
    // 建议直接用 API 的内部逻辑，但需要正确的 token
    
    console.log('⚠️  此脚本需要完整的 Fly machine 配置（镜像、环境变量等）');
    console.log('建议: 在 Telegram bot 里发送 /gateway 命令，会自动触发容器启动');
    
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
