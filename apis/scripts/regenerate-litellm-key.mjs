#!/usr/bin/env node
/**
 * 重新生成用户的 LiteLLM key 并重建 assistant 容器
 * 用于解决 401 Invalid proxy server token 错误（key 在 LiteLLM 中已失效）
 *
 * 用法：cd apis && npm run build && node scripts/regenerate-litellm-key.mjs <telegram_user_id>
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

const telegramUserId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
if (!telegramUserId || !Number.isFinite(telegramUserId)) {
  console.error('用法: node scripts/regenerate-litellm-key.mjs <telegram_user_id>');
  process.exit(1);
}

async function main() {
  const { ensureInfraRuntimeConfigured } = await import(`${distRoot}/domain/common/infraRuntime.js`);
  const { prepareContainerRuntime } = await import(`${distRoot}/domain/container/index.js`);
  const {
    getUserByTelegramId,
    listAssistantsByOwnerTelegramId,
    updateUser,
    updateAssistant
  } = await import(`${distRoot}/domain/common/db/index.js`);
  const { ensureTelegramUser } = await import(`${distRoot}/domain/user/service.js`);
  const { ensureLiteLLMKeyForAssistant } = await import(`${distRoot}/domain/litellm/index.js`);
  const { ensureAssistantContainer } = await import(`${distRoot}/domain/container/index.js`);
  const { db: paymentDb } = await import(`${distRoot}/domain/payment/db.js`);
  const { syncLiteLLMBudgetFromPlan, syncLiteLLMBudgetAbsolute } = await import(`${distRoot}/domain/payment/litellmBudget.js`);

  ensureInfraRuntimeConfigured();
  await prepareContainerRuntime();

  const user = await getUserByTelegramId(telegramUserId);
  if (!user) {
    console.error(`用户 telegram_user_id=${telegramUserId} 不存在`);
    process.exit(1);
  }

  const assistants = await listAssistantsByOwnerTelegramId(telegramUserId);
  if (!assistants.length) {
    console.error(`用户 ${telegramUserId} 没有 assistant`);
    process.exit(1);
  }

  console.log(`用户: ${user.telegram_username || telegramUserId}`);
  console.log(`Assistants: ${assistants.map((a) => `@${a.assistant_bot_username}`).join(', ')}`);

  // 1. 清空 key，强制重新生成
  console.log('\n[1] 清空现有 LiteLLM key...');
  await updateUser(telegramUserId, {
    litellm_virtual_key: '',
    litellm_key_alias: '',
    litellm_key_last4: null
  });
  for (const a of assistants) {
    await updateAssistant(a.id, {
      litellm_virtual_key: '',
      litellm_key_alias: '',
      litellm_key_last4: null
    });
  }
  console.log('    已清空');

  // 2. 先同步 budget 到 DB 和 LiteLLM（ensureUserLiteLLMKey 会读取 user.litellm_budget_usd）
  console.log('\n[2] 同步 LiteLLM budget...');
  const telegramUserIdStr = String(telegramUserId);
  const sub = await paymentDb.getSubscriptionByTelegramId(telegramUserIdStr);
  const planCode = sub?.plan_id?.trim();
  const isActive = sub?.status === 'active';
  if (isActive && planCode) {
    await syncLiteLLMBudgetFromPlan({
      telegram_user_id: telegramUserIdStr,
      telegram_username: user.telegram_username,
      plan_code: planCode,
      source: 'regenerate-litellm-key'
    });
    console.log(`    已按订阅计划同步 (plan: ${planCode})`);
  } else {
    const fallbackBudgetUsd = 1;
    await syncLiteLLMBudgetAbsolute({
      telegram_user_id: telegramUserIdStr,
      telegram_username: user.telegram_username,
      source: 'regenerate-litellm-key',
      budget_usd: fallbackBudgetUsd
    });
    console.log(`    无有效订阅，已设置默认 budget: $${fallbackBudgetUsd} (测试用)`);
  }

  // 3. 重新生成 key（ensureTelegramUser 会使用已同步的 user.litellm_budget_usd）
  console.log('\n[3] 在 LiteLLM 中重新生成 key...');
  const updatedUser = await ensureTelegramUser(telegramUserId, user.telegram_username);
  if (!updatedUser.litellm_virtual_key?.trim()) {
    console.error('    LiteLLM key 生成失败');
    process.exit(1);
  }
  console.log(`    新 key 已生成 (last4: ${updatedUser.litellm_key_last4 || '?'})`);

  // 4. 重建每个 assistant 的容器（ensureLiteLLMKey 会同步新 key，ensureAssistantContainer 会重建）
  console.log('\n[4] 重建 assistant 容器...');
  for (const assistant of assistants) {
    const owner = await getUserByTelegramId(telegramUserId);
    if (!owner?.gateway_token?.trim()) {
      console.error(`    @${assistant.assistant_bot_username}: 缺少 gateway_token`);
      continue;
    }
    try {
      const assistantWithKey = await ensureLiteLLMKeyForAssistant(telegramUserId, assistant);
      await ensureAssistantContainer(assistantWithKey, owner.gateway_token);
      console.log(`    @${assistant.assistant_bot_username}: 已重建`);
    } catch (err) {
      console.error(`    @${assistant.assistant_bot_username}: 失败`, err?.message || err);
    }
  }

  console.log('\n✅ 完成，请重新发送消息测试');
}

main().catch((err) => {
  console.error(err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
