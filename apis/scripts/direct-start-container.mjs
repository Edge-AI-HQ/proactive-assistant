#!/usr/bin/env node
/**
 * 直接启动助理容器（不走 HTTP API，直接调内部逻辑）
 * 用法：cd apis && npm run build && node scripts/direct-start-container.mjs <assistant_id>
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const apisRoot = resolve(__dirname, '..');
const repoRoot = resolve(apisRoot, '..');

for (const p of [
  resolve(repoRoot, '.env'),
  resolve(repoRoot, '.env.local'),
  resolve(apisRoot, '.env'),
  resolve(apisRoot, '.env.local')
]) {
  if (existsSync(p)) {
    dotenv.config({ path: p, override: false });
    break;
  }
}

const distRoot = resolve(apisRoot, 'dist/src');

const assistantId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
if (!assistantId) {
  console.error('请提供助理 ID: node scripts/direct-start-container.mjs <assistant_id>');
  process.exit(1);
}

try {
  const { ensureInfraRuntimeConfigured } = await import(`${distRoot}/domain/common/infraRuntime.js`);
  const { prepareContainerRuntime } = await import(`${distRoot}/domain/container/index.js`);
  const { getAssistantById } = await import(`${distRoot}/domain/common/db/assistantRepository.js`);
  const { getUserByTelegramId } = await import(`${distRoot}/domain/common/db/index.js`);
  const { ensureAssistantContainer } = await import(`${distRoot}/domain/container/index.js`);

  ensureInfraRuntimeConfigured();
  await prepareContainerRuntime();

  console.log(`正在启动助理 ${assistantId} 的容器...`);

  const assistant = await getAssistantById(assistantId);
  if (!assistant) {
    console.error(`助理 ${assistantId} 不存在`);
    process.exit(1);
  }

  const owner = await getUserByTelegramId(assistant.owner_telegram_user_id);
  if (!owner) {
    console.error(`所有者 (telegram_user_id=${assistant.owner_telegram_user_id}) 不存在`);
    process.exit(1);
  }

  if (!owner.gateway_token?.trim()) {
    console.error('所有者缺少 gateway_token');
    process.exit(1);
  }

  console.log(`助理: @${assistant.assistant_bot_username} (状态: ${assistant.container_status})`);
  console.log(`所有者: ${owner.telegram_username || owner.telegram_user_id}`);

  const result = await ensureAssistantContainer(assistant, owner.gateway_token);
  console.log(`✅ 容器启动完成:`, result);

  process.exit(0);
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('请先执行: cd apis && npm run build');
  } else {
    console.error('容器启动失败:', error?.message || error);
    if (error?.stack) console.error(error.stack);
  }
  process.exit(1);
}
