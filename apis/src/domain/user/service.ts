import { createLiteLLMUser, encryptLiteLLMKey, generateLiteLLMKey } from '../litellm/index.js';
import { config } from '../common/config.js';
import {
  createGatewayToken,
  createUser,
  deleteUserByTelegramId,
  getUserByTelegramId,
  listAssistantsByOwnerTelegramId,
  updateUser
} from '../common/db/index.js';
import type { UserRecord } from '../../types.js';

const normalizeUsername = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const buildLiteLLMUserId = (userId: number): string => String(userId);

const buildLiteLLMUserAlias = (telegramUserId: number, telegramUsername: string | null): string => {
  if (telegramUsername?.trim()) return `telegram:${telegramUserId}:@${telegramUsername.trim()}`;
  return `telegram:${telegramUserId}`;
};

const buildUserKeyAlias = (userId: number): string => `claw-user-${userId}`;

const keyLast4 = (value: string): string => {
  const raw = value.trim();
  if (!raw) return '';
  return raw.slice(-4);
};

const ensureUserLiteLLMKey = async (user: UserRecord): Promise<UserRecord> => {
  if (!config.litellm.enabled) return user;

  const litellmUserId = user.litellm_user_id?.trim() || buildLiteLLMUserId(user.id);
  const litellmUserAlias = user.litellm_user_alias?.trim() || buildLiteLLMUserAlias(user.telegram_user_id, user.telegram_username);

  await createLiteLLMUser({
    userId: litellmUserId,
    userAlias: litellmUserAlias,
    metadata: {
      source: 'pin-ai-assistant-apis',
      user_id: user.id,
      telegram_user_id: user.telegram_user_id,
      telegram_username: user.telegram_username || null
    }
  });

  let workingUser = user;
  if (user.litellm_user_id !== litellmUserId || user.litellm_user_alias !== litellmUserAlias) {
    workingUser =
      (await updateUser(user.telegram_user_id, {
        litellm_user_id: litellmUserId,
        litellm_user_alias: litellmUserAlias
      })) ?? workingUser;
  }

  const hasVirtualKey = Boolean(workingUser.litellm_virtual_key_encrypted?.trim());
  if (hasVirtualKey && workingUser.litellm_key_alias?.trim()) return workingUser;

  const generated = await generateLiteLLMKey({
    userId: litellmUserId,
    keyAlias: buildUserKeyAlias(workingUser.id),
    maxBudgetUsd: config.litellm.defaultBudgetUsd,
    budgetDuration: config.litellm.defaultBudgetDuration,
    rpmLimit: config.litellm.defaultRpmLimit,
    tpmLimit: config.litellm.defaultTpmLimit,
    models: config.litellm.allowedModels,
    metadata: {
      source: 'pin-ai-assistant-apis',
      owner_scope: 'shared-user-key',
      owner_user_id: workingUser.id,
      owner_telegram_user_id: workingUser.telegram_user_id
    }
  });

  const encrypted = encryptLiteLLMKey(generated.rawKey);
  const updated = await updateUser(workingUser.telegram_user_id, {
    litellm_user_id: generated.userId ?? litellmUserId,
    litellm_user_alias: litellmUserAlias,
    litellm_key_alias: generated.keyAlias ?? buildUserKeyAlias(workingUser.id),
    litellm_virtual_key_encrypted: encrypted,
    litellm_key_last4: keyLast4(generated.rawKey),
    litellm_spend_usd: 0,
    litellm_budget_usd: generated.maxBudgetUsd,
    litellm_budget_duration: generated.budgetDuration ?? config.litellm.defaultBudgetDuration,
    litellm_rpm_limit: generated.rpmLimit,
    litellm_tpm_limit: generated.tpmLimit,
    litellm_last_synced_at: new Date().toISOString()
  });

  return updated ?? workingUser;
};

export const ensureTelegramUser = async (telegramUserId: number, telegramUsername?: string | null): Promise<UserRecord> => {
  const normalizedUsername = normalizeUsername(telegramUsername);
  const existing = await getUserByTelegramId(telegramUserId);

  if (existing) {
    let updated = existing;
    if (existing.telegram_username !== normalizedUsername) {
      updated = (await updateUser(telegramUserId, { telegram_username: normalizedUsername })) ?? existing;
    }
    return ensureUserLiteLLMKey(updated);
  }

  const created = await createUser({
    telegram_user_id: telegramUserId,
    telegram_username: normalizedUsername,
    gateway_token: createGatewayToken()
  });

  if (!created) {
    const recovered = await getUserByTelegramId(telegramUserId);
    if (recovered) return ensureUserLiteLLMKey(recovered);
    throw new Error(`Failed to create Telegram user ${telegramUserId}`);
  }

  return ensureUserLiteLLMKey(created);
};

export const deleteTelegramUser = async (telegramUserId: number): Promise<UserRecord | undefined> => {
  const assistants = await listAssistantsByOwnerTelegramId(telegramUserId);
  if (assistants.length) {
    throw new Error('User still has assistants. Delete assistants first.');
  }
  return deleteUserByTelegramId(telegramUserId);
};
