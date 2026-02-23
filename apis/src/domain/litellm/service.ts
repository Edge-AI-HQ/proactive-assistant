import { getLiteLLMRuntime } from './runtime.js';
import type { LiteLLMAssistantRecord, LiteLLMUserRecord } from './types.js';
import { createLiteLLMUser } from './client.js';

const config = new Proxy({} as { litellm: ReturnType<typeof getLiteLLMRuntime>['config']['litellm'] }, {
  get: (_target, prop) => getLiteLLMRuntime().config[prop as keyof ReturnType<typeof getLiteLLMRuntime>['config']]
});

const getUserByTelegramId = (telegramUserId: number) => getLiteLLMRuntime().store.getUserByTelegramId(telegramUserId);
const listAssistantsByOwnerTelegramId = (ownerTelegramUserId: number) =>
  getLiteLLMRuntime().store.listAssistantsByOwnerTelegramId(ownerTelegramUserId);
const updateAssistant = (id: number, fields: Partial<LiteLLMAssistantRecord>) =>
  getLiteLLMRuntime().store.updateAssistant(id, fields);
const updateUser = (telegramUserId: number, fields: Partial<LiteLLMUserRecord>) =>
  getLiteLLMRuntime().store.updateUser(telegramUserId, fields);

const isLiteLLMEnabled = (): boolean => config.litellm.enabled;

const assertLiteLLMRuntimeConfigured = (): void => {
  if (!isLiteLLMEnabled()) return;

  const missing: string[] = [];
  if (!config.litellm.baseUrl.trim()) missing.push('LITELLM_BASE_URL');
  if (!config.litellm.masterKey.trim()) missing.push('LITELLM_MASTER_KEY');

  if (missing.length) {
    throw new Error(`LiteLLM is enabled but missing required config: ${missing.join(', ')}`);
  }
};

const buildLiteLLMUserId = (userId: number): string => String(userId);

const buildLiteLLMUserAlias = (telegramUserId: number, telegramUsername: string | null): string => {
  if (telegramUsername?.trim()) return `telegram:${telegramUserId}:@${telegramUsername.trim()}`;
  return `telegram:${telegramUserId}`;
};

type AssistantLiteLLMRef = Pick<LiteLLMAssistantRecord, 'assistant_bot_id' | 'litellm_virtual_key'>;
type UserLiteLLMRef = Pick<LiteLLMUserRecord, 'telegram_user_id' | 'litellm_virtual_key'>;

interface SharedLiteLLMKeyState {
  litellm_user_id: string;
  litellm_key_alias: string;
  litellm_virtual_key: string;
  litellm_key_last4: string | null;
}

const toSharedKeyStateFromUser = (owner: LiteLLMUserRecord): SharedLiteLLMKeyState | null => {
  const key = owner.litellm_virtual_key?.trim();
  const userId = owner.litellm_user_id?.trim();
  const alias = owner.litellm_key_alias?.trim();
  if (!key || !userId || !alias) return null;

  return {
    litellm_user_id: userId,
    litellm_key_alias: alias,
    litellm_virtual_key: key,
    litellm_key_last4: owner.litellm_key_last4
  };
};

const toSharedKeyStateFromAssistant = (assistant: LiteLLMAssistantRecord): SharedLiteLLMKeyState | null => {
  const key = assistant.litellm_virtual_key?.trim();
  const userId = assistant.litellm_user_id?.trim();
  const alias = assistant.litellm_key_alias?.trim();
  if (!key || !userId || !alias) return null;

  return {
    litellm_user_id: userId,
    litellm_key_alias: alias,
    litellm_virtual_key: key,
    litellm_key_last4: assistant.litellm_key_last4
  };
};

const sameSharedKey = (assistant: LiteLLMAssistantRecord, shared: SharedLiteLLMKeyState): boolean => {
  return (
    assistant.litellm_user_id === shared.litellm_user_id &&
    assistant.litellm_key_alias === shared.litellm_key_alias &&
    (assistant.litellm_virtual_key || '').trim() === shared.litellm_virtual_key &&
    assistant.litellm_key_last4 === shared.litellm_key_last4
  );
};

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

  // Keep LiteLLM user identity in sync, but never generate assistant-specific keys here.
  if (!owner.litellm_user_id?.trim()) {
    await createLiteLLMUser({
      userId: litellmUserId,
      userAlias: litellmUserAlias,
      autoCreateKey: false,
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

  let shared = toSharedKeyStateFromUser(owner) ?? toSharedKeyStateFromAssistant(assistant);

  if (!shared) {
    const siblings = await listAssistantsByOwnerTelegramId(ownerTelegramUserId);
    const siblingWithKey = siblings.find((item) => item.id !== assistant.id && item.litellm_virtual_key?.trim());
    if (siblingWithKey) {
      shared = toSharedKeyStateFromAssistant(siblingWithKey);
    }
  }

  if (!shared) {
    throw new Error(
      `Owner ${ownerTelegramUserId} is missing a LiteLLM virtual key. Re-run /start (or rotate key in LiteLLM and re-provision).`
    );
  }

  await updateUser(ownerTelegramUserId, {
    litellm_user_id: shared.litellm_user_id || litellmUserId,
    litellm_user_alias: litellmUserAlias,
    litellm_key_alias: shared.litellm_key_alias,
    litellm_virtual_key: shared.litellm_virtual_key,
    litellm_key_last4: shared.litellm_key_last4
  });

  if (sameSharedKey(assistant, shared)) {
    return assistant;
  }

  const updated = await updateAssistant(assistant.id, {
    litellm_user_id: shared.litellm_user_id || litellmUserId,
    litellm_key_alias: shared.litellm_key_alias,
    litellm_virtual_key: shared.litellm_virtual_key,
    litellm_key_last4: shared.litellm_key_last4
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
  const key = assistant.litellm_virtual_key?.trim();
  if (!key) return null;
  return key;
};

export const readUserLiteLLMVirtualKey = (user: UserLiteLLMRef): string | null => {
  if (!isLiteLLMEnabled()) return null;
  assertLiteLLMRuntimeConfigured();
  const key = user.litellm_virtual_key?.trim();
  if (!key) return null;
  return key;
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
