#!/usr/bin/env node
/**
 * 直接启动助理容器（不走 HTTP API，直接调内部逻辑）
 * 用法：SUPABASE_DB_URL=... node scripts/direct-start-container.mjs
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// 动态 import 项目代码
const { getAssistantById } = await import(`${projectRoot}/dist/domain/common/db/assistantRepository.js`);
const { getUserById } = await import(`${projectRoot}/dist/domain/common/db/userRepository.js`);
const { ensureAssistantContainer } = await import(`${projectRoot}/dist/domain/container/index.js`);

const assistantId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
if (!assistantId) {
  console.error('请提供助理 ID: node scripts/direct-start-container.mjs <assistant_id>');
  process.exit(1);
}

try {
  console.log(`正在启动助理 ${assistantId} 的容器...`);
  
  const assistant = await getAssistantById(assistantId);
  if (!assistant) {
    console.error(`助理 ${assistantId} 不存在`);
    process.exit(1);
  }

  const owner = await getUserById(assistant.owner_user_id);
  if (!owner) {
    console.error(`用户 ${assistant.owner_user_id} 不存在`);
    process.exit(1);
  }

  console.log(`助理: @${assistant.assistant_bot_username} (状态: ${assistant.container_status})`);
  console.log(`所有者: ${owner.telegram_username || owner.telegram_user_id}`);

  const result = await ensureAssistantContainer(assistant, owner.gateway_token);
  console.log(`✅ 容器启动完成:`, result);
  
  process.exit(0);
} catch (error) {
  console.error('容器启动失败:', error);
  process.exit(1);
}
