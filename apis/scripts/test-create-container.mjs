#!/usr/bin/env node
/**
 * 直接测试 Fly 容器创建（完整流程）
 *
 * 用法：
 *   cd apis && node scripts/test-create-container.mjs [assistant_id]
 *
 * 环境变量（从 .env 或环境加载）：
 *   SUPABASE_DB_URL, FLY_API_TOKEN, FLY_APP_NAME, OPENCLAW_IMAGE,
 *   CONTAINER_RUNTIME=fly, LITELLM_* 等
 *
 * 若不传 assistant_id，会列出可用的助理供选择。
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const apisRoot = resolve(__dirname, '..');
const repoRoot = resolve(apisRoot, '..');

// 加载 .env（与 config.ts 一致）
for (const p of [
  resolve(repoRoot, '.env'),
  resolve(repoRoot, '.env.local'),
  resolve(apisRoot, '.env'),
  resolve(apisRoot, '.env.local')
]) {
  dotenv.config({ path: p, override: false });
}

// 动态 import 编译后的代码（需先 npm run build）
const distRoot = resolve(apisRoot, 'dist/src');

async function loadModules() {
  try {
    const { ensureInfraRuntimeConfigured } = await import(`${distRoot}/domain/common/infraRuntime.js`);
    const { prepareContainerRuntime } = await import(`${distRoot}/domain/container/index.js`);
    const { ensureAssistantContainer } = await import(`${distRoot}/domain/container/index.js`);
    const { getAssistantById } = await import(`${distRoot}/domain/common/db/assistantRepository.js`);
    const { getUserByTelegramId } = await import(`${distRoot}/domain/common/db/index.js`);
    return {
      ensureInfraRuntimeConfigured,
      prepareContainerRuntime,
      ensureAssistantContainer,
      getAssistantById,
      getUserByTelegramId
    };
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.message?.includes('Cannot find module')) {
      console.error('❌ 请先执行: cd apis && npm run build');
      process.exit(1);
    }
    throw err;
  }
}

async function listAssistants(pool) {
  const res = await pool.query(`
    SELECT a.id, a.assistant_bot_id, a.assistant_bot_username,
           COALESCE(r.status, 'stopped') as container_status
    FROM assistants a
    LEFT JOIN runtime_instances r ON r.assistant_id = a.id AND r.scope = 'assistant'
    ORDER BY a.id DESC
    LIMIT 20
  `);
  return res.rows;
}

async function main() {
  const assistantIdArg = process.argv[2];
  const dbUrl = (process.env.SUPABASE_DB_URL || '').trim();
  const flyToken = (process.env.FLY_API_TOKEN || '').trim();
  const flyApp = (process.env.FLY_APP_NAME || '').trim();
  const openclawImage = (process.env.OPENCLAW_IMAGE || '').trim();
  const containerRuntime = (process.env.CONTAINER_RUNTIME || 'docker').toLowerCase();

  console.log('--- 环境检查 ---');
  console.log('SUPABASE_DB_URL:', dbUrl ? '✓ 已设置' : '✗ 未设置');
  console.log('FLY_API_TOKEN:', flyToken ? '✓ 已设置' : '✗ 未设置');
  console.log('FLY_APP_NAME:', flyApp || '(空，将用 pinclaw-api-dev)');
  console.log('CONTAINER_RUNTIME:', containerRuntime);
  console.log('OPENCLAW_IMAGE:', openclawImage || '(未设置)');

  if (!dbUrl) {
    console.error('\n❌ 请设置 SUPABASE_DB_URL');
    process.exit(1);
  }

  if (containerRuntime === 'fly' && (!flyToken || !flyApp)) {
    console.error('\n❌ Fly 模式需要 FLY_API_TOKEN 和 FLY_APP_NAME');
    process.exit(1);
  }

  if (containerRuntime === 'fly' && (!openclawImage || !openclawImage.includes('@sha256:'))) {
    console.error('\n❌ Fly 模式需要 OPENCLAW_IMAGE 为 digest 格式，例如: registry.fly.io/xxx@sha256:...');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl });

  try {
    let assistantId = assistantIdArg ? parseInt(assistantIdArg, 10) : null;
    if (!assistantId || !Number.isFinite(assistantId)) {
      const assistants = await listAssistants(pool);
      if (assistants.length === 0) {
        console.error('\n❌ 数据库中没有助理记录');
        process.exit(1);
      }
      console.log('\n--- 可用助理 ---');
      assistants.forEach((a) => {
        console.log(`  ${a.id}: @${a.assistant_bot_username} (bot_id=${a.assistant_bot_id}, 状态=${a.container_status})`);
      });
      console.log('\n用法: node scripts/test-create-container.mjs <assistant_id>');
      process.exit(0);
    }

    const mods = await loadModules();
    mods.ensureInfraRuntimeConfigured();
    await mods.prepareContainerRuntime();

    const assistant = await mods.getAssistantById(assistantId);
    if (!assistant) {
      console.error(`\n❌ 助理 ${assistantId} 不存在`);
      process.exit(1);
    }

    const owner = await mods.getUserByTelegramId(assistant.owner_telegram_user_id);
    if (!owner) {
      console.error(`\n❌ 所有者 (telegram_user_id=${assistant.owner_telegram_user_id}) 不存在`);
      process.exit(1);
    }

    if (!owner.gateway_token?.trim()) {
      console.error('\n❌ 所有者缺少 gateway_token');
      process.exit(1);
    }

    console.log('\n--- 创建容器 ---');
    console.log(`助理: @${assistant.assistant_bot_username} (id=${assistant.id}, bot_id=${assistant.assistant_bot_id})`);
    console.log(`所有者: ${owner.telegram_username || owner.telegram_user_id}`);
    console.log('');

    const result = await mods.ensureAssistantContainer(assistant, owner.gateway_token);
    console.log('✅ 容器创建完成:', result);
  } catch (err) {
    console.error('\n❌ 创建失败:', err?.message || err);
    if (err?.stack) {
      console.error('\n堆栈:');
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
