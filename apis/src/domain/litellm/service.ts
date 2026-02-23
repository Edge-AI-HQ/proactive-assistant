import { getLiteLLMRuntime } from './runtime.js';
import type { LiteLLMAssistantRecord, LiteLLMSyncSummary, LiteLLMUserRecord } from './types.js';
import { createLiteLLMUser, generateLiteLLMKey, getLiteLLMVirtualKeyInfo } from './client.js';
import { decryptLiteLLMKey, encryptLiteLLMKey } from './crypto.js';

const config = new Proxy({} as { litellm: ReturnType<typeof getLiteLLMRuntime>['config']['litellm'] }, {
  get: (_target, prop) => getLiteLLMRuntime().config[prop as keyof ReturnType<typeof getLiteLLMRuntime>['config']]
});

const getUserByTelegramId = (telegramUserId: number) => getLiteLLMRuntime().store.getUserByTelegramId(telegramUserId);
const listAssistantsByOwnerTelegramId = (ownerTelegramUserId: number) =>
  getLiteLLMRuntime().store.listAssistantsByOwnerTelegramId(ownerTelegramUserId);
const listAssistantsWithLiteLLMKey = () => getLiteLLMRuntime().store.listAssistantsWithLiteLLMKey();
const updateAssistant = (id: number, fields: Partial<LiteLLMAssistantRecord>) =>
  getLiteLLMRuntime().store.updateAssistant(id, fields);
const updateUser = (telegramUserId: number, fields: Partial<LiteLLMUserRecord>) =>
  getLiteLLMRuntime().store.updateUser(telegramUserId, fields);

const clampNonNegative = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

const isLiteLLMEnabled = (): boolean => config.litellm.enabled;

const assertLiteLLMRuntimeConfigured = (): void => {
  if (!isLiteLLMEnabled()) return;

  const missing: string[] = [];
  if (!config.litellm.baseUrl.trim()) missing.push('LITELLM_BASE_URL');
  if (!config.litellm.masterKey.trim()) missing.push('LITELLM_MASTER_KEY');
  if (!config.litellm.keyEncryptionSecret.trim()) missing.push('LITELLM_KEY_ENCRYPTION_SECRET');

  if (missing.length) {
    throw new Error(`LiteLLM is enabled but missing required config: ${missing.join(', ')}`);
  }
};

const buildLiteLLMUserId = (userId: number): string => String(userId);

const buildLiteLLMUserAlias = (telegramUserId: number, telegramUsername: string | null): string => {
  if (telegramUsername?.trim()) return `telegram:${telegramUserId}:@${telegramUsername.trim()}`;
  return `telegram:${telegramUserId}`;
};

const buildUserKeyAlias = (userId: number): string => `claw-user-${userId}`;
const buildAssistantKeyAlias = (assistantBotId: number): string => `${config.litellm.keyAliasPrefix}${assistantBotId}`;

const keyLast4 = (value: string): string => {
  const raw = value.trim();
  if (!raw) return '';
  return raw.slice(-4);
};

type AssistantLiteLLMRef = Pick<LiteLLMAssistantRecord, 'assistant_bot_id' | 'litellm_virtual_key_encrypted'>;
type UserLiteLLMRef = Pick<LiteLLMUserRecord, 'telegram_user_id' | 'litellm_virtual_key_encrypted'>;

interface SharedLiteLLMKeyState {
  litellm_user_id: string;
  litellm_key_alias: string;
  litellm_virtual_key_encrypted: string;
  litellm_key_last4: string | null;
  litellm_spend_usd: number;
  litellm_budget_usd: number | null;
  litellm_budget_duration: string | null;
  litellm_rpm_limit: number | null;
  litellm_tpm_limit: number | null;
  litellm_last_synced_at: string | null;
}

const toSharedKeyStateFromUser = (owner: LiteLLMUserRecord): SharedLiteLLMKeyState | null => {
  const encrypted = owner.litellm_virtual_key_encrypted?.trim();
  const userId = owner.litellm_user_id?.trim();
  const alias = owner.litellm_key_alias?.trim();
  if (!encrypted || !userId || !alias) return null;

  return {
    litellm_user_id: userId,
    litellm_key_alias: alias,
    litellm_virtual_key_encrypted: encrypted,
    litellm_key_last4: owner.litellm_key_last4,
    litellm_spend_usd: clampNonNegative(owner.litellm_spend_usd),
    litellm_budget_usd: owner.litellm_budget_usd,
    litellm_budget_duration: owner.litellm_budget_duration,
    litellm_rpm_limit: owner.litellm_rpm_limit,
    litellm_tpm_limit: owner.litellm_tpm_limit,
    litellm_last_synced_at: owner.litellm_last_synced_at
  };
};

const toSharedKeyStateFromAssistant = (assistant: LiteLLMAssistantRecord): SharedLiteLLMKeyState | null => {
  const encrypted = assistant.litellm_virtual_key_encrypted?.trim();
  const userId = assistant.litellm_user_id?.trim();
  const alias = assistant.litellm_key_alias?.trim();
  if (!encrypted || !userId || !alias) return null;

  return {
    litellm_user_id: userId,
    litellm_key_alias: alias,
    litellm_virtual_key_encrypted: encrypted,
    litellm_key_last4: assistant.litellm_key_last4,
    litellm_spend_usd: clampNonNegative(assistant.litellm_spend_usd),
    litellm_budget_usd: assistant.litellm_budget_usd,
    litellm_budget_duration: assistant.litellm_budget_duration,
    litellm_rpm_limit: assistant.litellm_rpm_limit,
    litellm_tpm_limit: assistant.litellm_tpm_limit,
    litellm_last_synced_at: assistant.litellm_last_synced_at
  };
};

const sameSharedKey = (assistant: LiteLLMAssistantRecord, shared: SharedLiteLLMKeyState): boolean => {
  return (
    assistant.litellm_user_id === shared.litellm_user_id &&
    assistant.litellm_key_alias === shared.litellm_key_alias &&
    (assistant.litellm_virtual_key_encrypted || '').trim() === shared.litellm_virtual_key_encrypted &&
    assistant.litellm_key_last4 === shared.litellm_key_last4 &&
    clampNonNegative(assistant.litellm_spend_usd) === clampNonNegative(shared.litellm_spend_usd) &&
    assistant.litellm_budget_usd === shared.litellm_budget_usd &&
    assistant.litellm_budget_duration === shared.litellm_budget_duration &&
    assistant.litellm_rpm_limit === shared.litellm_rpm_limit &&
    assistant.litellm_tpm_limit === shared.litellm_tpm_limit
  );
};

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

const isPgSchemaMismatchError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === '42703' || code === '42P01';
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : 'Unknown error');

const ownerProvisionLockTails = new Map<number, Promise<void>>();

const withOwnerProvisionLock = async <T>(ownerTelegramUserId: number, task: () => Promise<T>): Promise<T> => {
  const tail = ownerProvisionLockTails.get(ownerTelegramUserId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const queued = tail.then(() => gate);
  ownerProvisionLockTails.set(ownerTelegramUserId, queued);

  await tail;
  try {
    return await task();
  } finally {
    if (release) release();
    if (ownerProvisionLockTails.get(ownerTelegramUserId) === queued) {
      ownerProvisionLockTails.delete(ownerTelegramUserId);
    }
  }
};

const ensureLiteLLMKeyForAssistantInternal = async (
  ownerTelegramUserId: number,
  assistant: LiteLLMAssistantRecord
): Promise<LiteLLMAssistantRecord> => {
  if (!isLiteLLMEnabled()) return assistant;
  assertLiteLLMRuntimeConfigured();

  const owner = await getUserByTelegramId(ownerTelegramUserId);
  if (!owner) {
    throw new Error(`Cannot create LiteLLM identity: owner ${ownerTelegramUserId} not found`);
  }

  const litellmUserId = owner.litellm_user_id?.trim() || assistant.litellm_user_id?.trim() || buildLiteLLMUserId(owner.id);
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
        user_id: owner.id,
        telegram_user_id: ownerTelegramUserId,
        telegram_username: owner.telegram_username || null
      }
    });
  }

  const ownerNeedsIdentityUpdate = owner.litellm_user_id !== litellmUserId || owner.litellm_user_alias !== litellmUserAlias;
  if (ownerNeedsIdentityUpdate) {
    await updateUser(ownerTelegramUserId, {
      litellm_user_id: litellmUserId,
      litellm_user_alias: litellmUserAlias
    });
  }

  const ownerSharedKey =
    toSharedKeyStateFromUser(owner) ??
    toSharedKeyStateFromAssistant(assistant) ??
    (() => {
      // Reuse existing key from sibling assistants to guarantee one-key-per-user.
      // Prefer newest records because list API is ordered by created_at desc.
      return null;
    })();

  let shared = ownerSharedKey;
  if (!shared) {
    const siblings = await listAssistantsByOwnerTelegramId(ownerTelegramUserId);
    const siblingWithKey = siblings.find((item) => item.id !== assistant.id && item.litellm_virtual_key_encrypted?.trim());
    if (siblingWithKey) {
      shared = toSharedKeyStateFromAssistant(siblingWithKey);
    }
  }

  if (shared) {
    await updateUser(ownerTelegramUserId, {
      litellm_user_id: shared.litellm_user_id || litellmUserId,
      litellm_user_alias: litellmUserAlias,
      litellm_key_alias: shared.litellm_key_alias,
      litellm_virtual_key_encrypted: shared.litellm_virtual_key_encrypted,
      litellm_key_last4: shared.litellm_key_last4,
      litellm_spend_usd: shared.litellm_spend_usd,
      litellm_budget_usd: shared.litellm_budget_usd,
      litellm_budget_duration: shared.litellm_budget_duration,
      litellm_rpm_limit: shared.litellm_rpm_limit,
      litellm_tpm_limit: shared.litellm_tpm_limit,
      litellm_last_synced_at: shared.litellm_last_synced_at
    });

    if (sameSharedKey(assistant, shared)) {
      return assistant;
    }

    return (
      (await updateAssistant(assistant.id, {
        litellm_user_id: shared.litellm_user_id || litellmUserId,
        litellm_key_alias: shared.litellm_key_alias,
        litellm_virtual_key_encrypted: shared.litellm_virtual_key_encrypted,
        litellm_key_last4: shared.litellm_key_last4,
        litellm_spend_usd: shared.litellm_spend_usd,
        litellm_budget_usd: shared.litellm_budget_usd,
        litellm_budget_duration: shared.litellm_budget_duration,
        litellm_rpm_limit: shared.litellm_rpm_limit,
        litellm_tpm_limit: shared.litellm_tpm_limit,
        litellm_last_synced_at: shared.litellm_last_synced_at
      })) ?? assistant
    );
  }

  const baseAlias = buildUserKeyAlias(owner.id);
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
      owner_user_id: owner.id,
      owner_telegram_user_id: ownerTelegramUserId,
      owner_scope: 'shared-user-key',
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
          user_id: owner.id,
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
  const sharedKeyState: SharedLiteLLMKeyState = {
    litellm_user_id: generated.userId ?? litellmUserId,
    litellm_key_alias: generated.keyAlias ?? baseAlias,
    litellm_virtual_key_encrypted: encryptedKey,
    litellm_key_last4: keyLast4(generated.rawKey),
    litellm_spend_usd: 0,
    litellm_budget_usd: generated.maxBudgetUsd,
    litellm_budget_duration: generated.budgetDuration ?? config.litellm.defaultBudgetDuration,
    litellm_rpm_limit: generated.rpmLimit,
    litellm_tpm_limit: generated.tpmLimit,
    litellm_last_synced_at: now
  };

  await updateUser(ownerTelegramUserId, {
    litellm_user_id: sharedKeyState.litellm_user_id,
    litellm_user_alias: litellmUserAlias,
    litellm_key_alias: sharedKeyState.litellm_key_alias,
    litellm_virtual_key_encrypted: sharedKeyState.litellm_virtual_key_encrypted,
    litellm_key_last4: sharedKeyState.litellm_key_last4,
    litellm_spend_usd: sharedKeyState.litellm_spend_usd,
    litellm_budget_usd: sharedKeyState.litellm_budget_usd,
    litellm_budget_duration: sharedKeyState.litellm_budget_duration,
    litellm_rpm_limit: sharedKeyState.litellm_rpm_limit,
    litellm_tpm_limit: sharedKeyState.litellm_tpm_limit,
    litellm_last_synced_at: sharedKeyState.litellm_last_synced_at
  });

  const updated = await updateAssistant(assistant.id, {
    litellm_user_id: sharedKeyState.litellm_user_id,
    litellm_key_alias: sharedKeyState.litellm_key_alias,
    litellm_virtual_key_encrypted: sharedKeyState.litellm_virtual_key_encrypted,
    litellm_key_last4: sharedKeyState.litellm_key_last4,
    litellm_spend_usd: sharedKeyState.litellm_spend_usd,
    litellm_budget_usd: sharedKeyState.litellm_budget_usd,
    litellm_budget_duration: sharedKeyState.litellm_budget_duration,
    litellm_rpm_limit: sharedKeyState.litellm_rpm_limit,
    litellm_tpm_limit: sharedKeyState.litellm_tpm_limit,
    litellm_last_synced_at: sharedKeyState.litellm_last_synced_at
  });

  if (!updated) {
    throw new Error(`Failed to persist LiteLLM key mapping for assistant ${assistant.assistant_bot_id}`);
  }

  return updated;
};

export const ensureLiteLLMKeyForAssistant = async (
  ownerTelegramUserId: number,
  assistant: LiteLLMAssistantRecord
): Promise<LiteLLMAssistantRecord> => {
  return withOwnerProvisionLock(ownerTelegramUserId, () =>
    ensureLiteLLMKeyForAssistantInternal(ownerTelegramUserId, assistant)
  );
};

export const readAssistantLiteLLMVirtualKey = (assistant: AssistantLiteLLMRef): string | null => {
  if (!isLiteLLMEnabled()) return null;
  assertLiteLLMRuntimeConfigured();
  const encrypted = assistant.litellm_virtual_key_encrypted?.trim();
  if (!encrypted) return null;
  return decryptLiteLLMKey(encrypted);
};

export const readUserLiteLLMVirtualKey = (user: UserLiteLLMRef): string | null => {
  if (!isLiteLLMEnabled()) return null;
  assertLiteLLMRuntimeConfigured();
  const encrypted = user.litellm_virtual_key_encrypted?.trim();
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

export const syncAssistantLiteLLMBilling = async (assistant: LiteLLMAssistantRecord): Promise<LiteLLMAssistantRecord> => {
  if (!isLiteLLMEnabled()) return assistant;

  const key = readAssistantLiteLLMVirtualKey(assistant);
  if (!key) {
    throw new Error(`Assistant ${assistant.assistant_bot_id} missing LiteLLM virtual key`);
  }

  const info = await getLiteLLMVirtualKeyInfo(key);
  const now = new Date().toISOString();
  const syncedState = {
    litellm_user_id: info.userId ?? assistant.litellm_user_id,
    litellm_key_alias: info.keyAlias ?? assistant.litellm_key_alias,
    litellm_spend_usd: clampNonNegative(info.spendUsd),
    litellm_budget_usd: info.maxBudgetUsd ?? assistant.litellm_budget_usd,
    litellm_budget_duration: info.budgetDuration ?? assistant.litellm_budget_duration,
    litellm_rpm_limit: info.rpmLimit ?? assistant.litellm_rpm_limit,
    litellm_tpm_limit: info.tpmLimit ?? assistant.litellm_tpm_limit,
    litellm_last_synced_at: now
  };

  const updated = await updateAssistant(assistant.id, {
    litellm_user_id: syncedState.litellm_user_id,
    litellm_key_alias: syncedState.litellm_key_alias,
    litellm_spend_usd: syncedState.litellm_spend_usd,
    litellm_budget_usd: syncedState.litellm_budget_usd,
    litellm_budget_duration: syncedState.litellm_budget_duration,
    litellm_rpm_limit: syncedState.litellm_rpm_limit,
    litellm_tpm_limit: syncedState.litellm_tpm_limit,
    litellm_last_synced_at: syncedState.litellm_last_synced_at
  });

  await updateUser(assistant.owner_telegram_user_id, {
    litellm_user_id: syncedState.litellm_user_id,
    litellm_key_alias: syncedState.litellm_key_alias,
    litellm_spend_usd: syncedState.litellm_spend_usd,
    litellm_budget_usd: syncedState.litellm_budget_usd,
    litellm_budget_duration: syncedState.litellm_budget_duration,
    litellm_rpm_limit: syncedState.litellm_rpm_limit,
    litellm_tpm_limit: syncedState.litellm_tpm_limit,
    litellm_last_synced_at: syncedState.litellm_last_synced_at
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
  assertLiteLLMRuntimeConfigured();

  const assistants = await listAssistantsWithLiteLLMKey();
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
let syncDisabledForSchemaMismatch = false;

const stopLiteLLMBillingSyncLoop = (): void => {
  if (!syncTimer) return;
  clearInterval(syncTimer);
  syncTimer = null;
};

const runLiteLLMSyncSafely = async (): Promise<void> => {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const result = await syncLiteLLMBilling();
    if (result.synced > 0 || result.failed > 0) {
      console.info('[litellm] billing sync result', result);
    }
  } catch (error: unknown) {
    if (isPgSchemaMismatchError(error)) {
      if (!syncDisabledForSchemaMismatch) {
        syncDisabledForSchemaMismatch = true;
        console.error(
          '[litellm] billing sync disabled due to database schema mismatch. Apply 005_add_missing_litellm_columns.sql, then the remaining SQL migrations in apis/db/migrations, and restart the API.',
          { error: describeError(error) }
        );
      }
      stopLiteLLMBillingSyncLoop();
      return;
    }
    console.error('[litellm] billing sync crashed', error);
  } finally {
    syncInFlight = false;
  }
};

export const startLiteLLMBillingSyncLoop = (): void => {
  if (!isLiteLLMEnabled()) return;
  if (syncTimer) return;
  if (syncDisabledForSchemaMismatch) return;

  const intervalMs = Math.max(60_000, config.litellm.syncIntervalMs);
  void runLiteLLMSyncSafely();
  syncTimer = setInterval(() => {
    void runLiteLLMSyncSafely();
  }, intervalMs);
};
