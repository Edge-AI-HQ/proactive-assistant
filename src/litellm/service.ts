import { config } from '../config.js';
import {
  getUserByTelegramId,
  listAssistantsWithLiteLLMKey,
  updateAssistant,
  updateUser
} from '../db.js';
import type { AssistantRecord } from '../types.js';
import { createLiteLLMUser, generateLiteLLMKey, getLiteLLMVirtualKeyInfo } from './client.js';
import { decryptLiteLLMKey, encryptLiteLLMKey } from './crypto.js';

const clampNonNegative = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

const isLiteLLMEnabled = (): boolean => config.litellm.enabled;

const buildLiteLLMUserId = (telegramUserId: number): string => `${config.litellm.userIdPrefix}${telegramUserId}`;

const buildLiteLLMUserAlias = (telegramUserId: number, telegramUsername: string | null): string => {
  if (telegramUsername?.trim()) return `telegram:${telegramUserId}:@${telegramUsername.trim()}`;
  return `telegram:${telegramUserId}`;
};

const buildAssistantKeyAlias = (assistantBotId: number): string => `${config.litellm.keyAliasPrefix}${assistantBotId}`;

const keyLast4 = (value: string): string => {
  const raw = value.trim();
  if (!raw) return '';
  return raw.slice(-4);
};

type AssistantLiteLLMRef = Pick<AssistantRecord, 'assistant_bot_id' | 'litellm_virtual_key_encrypted'>;

const shouldRetryWithUserCreate = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const mentionsUser = message.includes('user');
  const missingLike =
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('invalid user') ||
    message.includes('unknown user');
  return mentionsUser && missingLike;
};

const shouldRetryWithAliasConflict = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const mentionsAlias = message.includes('key_alias') || message.includes('key alias') || message.includes('alias');
  const duplicateLike = message.includes('already exists') || message.includes('duplicate') || message.includes('unique');
  return mentionsAlias && duplicateLike;
};

const makeAliasRetrySuffix = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface LiteLLMSyncSummary {
  synced: number;
  failed: number;
  details: Array<{ assistantId: number; message: string }>;
}

export const ensureLiteLLMKeyForAssistant = async (
  ownerTelegramUserId: number,
  assistant: AssistantRecord
): Promise<AssistantRecord> => {
  if (!isLiteLLMEnabled()) return assistant;

  const owner = getUserByTelegramId(ownerTelegramUserId);
  if (!owner) {
    throw new Error(`Cannot create LiteLLM identity: owner ${ownerTelegramUserId} not found`);
  }

  const litellmUserId = owner.litellm_user_id?.trim() || assistant.litellm_user_id?.trim() || buildLiteLLMUserId(ownerTelegramUserId);
  const litellmUserAlias =
    owner.litellm_user_alias?.trim() || buildLiteLLMUserAlias(ownerTelegramUserId, owner.telegram_username);

  // Avoid noisy 409 logs on every assistant creation for the same owner.
  // Create user proactively only when local mapping is missing.
  const ownerHasLiteLLMUser = Boolean(owner.litellm_user_id?.trim());
  if (!ownerHasLiteLLMUser) {
    await createLiteLLMUser({
      userId: litellmUserId,
      userAlias: litellmUserAlias,
      metadata: {
        source: 'pin-ai-assistant',
        telegram_user_id: ownerTelegramUserId,
        telegram_username: owner.telegram_username || null
      }
    });
  }

  if (owner.litellm_user_id !== litellmUserId || owner.litellm_user_alias !== litellmUserAlias) {
    updateUser(ownerTelegramUserId, {
      litellm_user_id: litellmUserId,
      litellm_user_alias: litellmUserAlias
    });
  }

  if (assistant.litellm_virtual_key_encrypted?.trim()) {
    if (assistant.litellm_user_id === litellmUserId) {
      return assistant;
    }

    return (
      updateAssistant(assistant.id, {
        litellm_user_id: litellmUserId
      }) ?? assistant
    );
  }

  const baseAlias = buildAssistantKeyAlias(assistant.assistant_bot_id);
  const buildGenerateInput = (keyAlias: string) => ({
    userId: litellmUserId,
    keyAlias,
    maxBudgetUsd: config.litellm.defaultBudgetUsd,
    budgetDuration: config.litellm.defaultBudgetDuration,
    rpmLimit: config.litellm.defaultRpmLimit,
    tpmLimit: config.litellm.defaultTpmLimit,
    models: config.litellm.allowedModels,
    metadata: {
      source: 'pin-ai-assistant',
      owner_telegram_user_id: ownerTelegramUserId,
      assistant_bot_id: assistant.assistant_bot_id,
      assistant_bot_username: assistant.assistant_bot_username
    }
  });

  const generateWithUserRecovery = async (keyAlias: string) => {
    const input = buildGenerateInput(keyAlias);
    try {
      return await generateLiteLLMKey(input);
    } catch (error: unknown) {
      if (!shouldRetryWithUserCreate(error)) throw error;

      await createLiteLLMUser({
        userId: litellmUserId,
        userAlias: litellmUserAlias,
        metadata: {
          source: 'pin-ai-assistant',
          telegram_user_id: ownerTelegramUserId,
          telegram_username: owner.telegram_username || null
        }
      });

      return generateLiteLLMKey(input);
    }
  };

  const generated = await (async () => {
    try {
      return await generateWithUserRecovery(baseAlias);
    } catch (error: unknown) {
      if (!shouldRetryWithAliasConflict(error)) throw error;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const retryAlias = `${baseAlias}-r${makeAliasRetrySuffix()}`;
        console.warn('[litellm] key alias conflict, retrying with new alias', {
          assistantBotId: assistant.assistant_bot_id,
          ownerTelegramUserId,
          retryAlias,
          attempt
        });
        try {
          return await generateWithUserRecovery(retryAlias);
        } catch (retryError: unknown) {
          if (attempt >= 3 || !shouldRetryWithAliasConflict(retryError)) {
            throw retryError;
          }
        }
      }

      throw error;
    }
  })();

  const encryptedKey = encryptLiteLLMKey(generated.rawKey);
  const now = new Date().toISOString();

  const updated = updateAssistant(assistant.id, {
    litellm_user_id: generated.userId ?? litellmUserId,
    litellm_key_alias: generated.keyAlias ?? buildAssistantKeyAlias(assistant.assistant_bot_id),
    litellm_virtual_key_encrypted: encryptedKey,
    litellm_key_last4: keyLast4(generated.rawKey),
    litellm_spend_usd: 0,
    litellm_budget_usd: generated.maxBudgetUsd,
    litellm_budget_duration: generated.budgetDuration ?? config.litellm.defaultBudgetDuration,
    litellm_rpm_limit: generated.rpmLimit,
    litellm_tpm_limit: generated.tpmLimit,
    litellm_last_synced_at: now
  });

  if (!updated) {
    throw new Error(`Failed to persist LiteLLM key mapping for assistant ${assistant.assistant_bot_id}`);
  }

  return updated;
};

export const readAssistantLiteLLMVirtualKey = (assistant: AssistantLiteLLMRef): string | null => {
  if (!isLiteLLMEnabled()) return null;
  const encrypted = assistant.litellm_virtual_key_encrypted?.trim();
  if (!encrypted) return null;
  return decryptLiteLLMKey(encrypted);
};

export const resolveAssistantLiteLLMEnv = (assistant: AssistantLiteLLMRef): Record<string, string> | null => {
  if (!isLiteLLMEnabled()) return null;

  const key = readAssistantLiteLLMVirtualKey(assistant);
  if (!key) {
    throw new Error(`Assistant ${assistant.assistant_bot_id} missing LiteLLM virtual key`);
  }

  const env: Record<string, string> = {
    LITELLM_API_KEY: key,
    LITELLM_BASE_URL: config.litellm.containerBaseUrl,
    PINAI_LITELLM_BASE_URL: config.litellm.containerBaseUrl
  };

  return env;
};

export const syncAssistantLiteLLMBilling = async (assistant: AssistantRecord): Promise<AssistantRecord> => {
  if (!isLiteLLMEnabled()) return assistant;

  const key = readAssistantLiteLLMVirtualKey(assistant);
  if (!key) {
    throw new Error(`Assistant ${assistant.assistant_bot_id} missing LiteLLM virtual key`);
  }

  const info = await getLiteLLMVirtualKeyInfo(key);
  const updated = updateAssistant(assistant.id, {
    litellm_user_id: info.userId ?? assistant.litellm_user_id,
    litellm_key_alias: info.keyAlias ?? assistant.litellm_key_alias,
    litellm_spend_usd: clampNonNegative(info.spendUsd),
    litellm_budget_usd: info.maxBudgetUsd ?? assistant.litellm_budget_usd,
    litellm_budget_duration: info.budgetDuration ?? assistant.litellm_budget_duration,
    litellm_rpm_limit: info.rpmLimit ?? assistant.litellm_rpm_limit,
    litellm_tpm_limit: info.tpmLimit ?? assistant.litellm_tpm_limit,
    litellm_last_synced_at: new Date().toISOString()
  });

  if (!updated) {
    throw new Error(`Failed to persist LiteLLM billing sync for assistant ${assistant.id}`);
  }
  return updated;
};

export const syncLiteLLMBilling = async (): Promise<LiteLLMSyncSummary> => {
  if (!isLiteLLMEnabled()) {
    return { synced: 0, failed: 0, details: [] };
  }

  const assistants = listAssistantsWithLiteLLMKey();
  const details: Array<{ assistantId: number; message: string }> = [];
  let synced = 0;
  let failed = 0;

  for (const assistant of assistants) {
    try {
      await syncAssistantLiteLLMBilling(assistant);
      synced += 1;
    } catch (error: unknown) {
      failed += 1;
      const message = error instanceof Error ? error.message : 'Unknown error';
      details.push({
        assistantId: assistant.id,
        message
      });
      console.error('[litellm] billing sync failed', {
        assistantId: assistant.id,
        assistantBotId: assistant.assistant_bot_id,
        message
      });
    }
  }

  return { synced, failed, details };
};

let syncTimer: NodeJS.Timeout | null = null;
let syncInFlight = false;

const runLiteLLMSyncSafely = async (): Promise<void> => {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const result = await syncLiteLLMBilling();
    if (result.synced > 0 || result.failed > 0) {
      console.info('[litellm] billing sync result', result);
    }
  } catch (error: unknown) {
    console.error('[litellm] billing sync crashed', error);
  } finally {
    syncInFlight = false;
  }
};

export const startLiteLLMBillingSyncLoop = (): void => {
  if (!isLiteLLMEnabled()) return;
  if (syncTimer) return;

  const intervalMs = Math.max(60_000, config.litellm.syncIntervalMs);
  void runLiteLLMSyncSafely();
  syncTimer = setInterval(() => {
    void runLiteLLMSyncSafely();
  }, intervalMs);
};
