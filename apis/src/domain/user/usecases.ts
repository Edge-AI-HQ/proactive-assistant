import { getUserByTelegramId, listAssistantsByOwnerTelegramId, deleteUserByTelegramId } from '../common/db/index.js';
import { DomainError } from '../common/errors.js';
import { deleteTelegramUser, ensureTelegramUser } from './service.js';
import { removeAssistantById } from '../claw-assistant/service.js';
import { cancelStripeSubscriptionImmediately } from '../payment/checkout.js';
import { deleteLiteLLMKey, deleteLiteLLMUser, isLiteLLMClientEnabled } from '../litellm/index.js';
import { disconnectGoogleOAuth } from '../google-oauth/service.js';
import type { UserRecord } from '../../types.js';

export interface EnsureTelegramUserInput {
  telegramUserId: number;
  telegramUsername: string | null;
}

const parsePositiveInt = (value: unknown): number | null => {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

export const parseEnsureTelegramUserInput = (body: unknown): EnsureTelegramUserInput => {
  if (!body || typeof body !== 'object') {
    throw new DomainError('INVALID_INPUT', 'Invalid payload. provider=telegram and provider_user_id are required.');
  }

  const record = body as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider.trim().toLowerCase() : 'telegram';
  if (provider !== 'telegram') {
    throw new DomainError('INVALID_INPUT', 'Invalid payload. provider=telegram and provider_user_id are required.');
  }

  const telegramUserId = parsePositiveInt(record.provider_user_id ?? record.telegram_user_id);
  if (!telegramUserId) {
    throw new DomainError('INVALID_INPUT', 'Invalid payload. provider=telegram and provider_user_id are required.');
  }

  const usernameRaw = record.provider_username ?? record.telegram_username;
  const telegramUsername =
    typeof usernameRaw === 'string' && usernameRaw.trim().length > 0 ? usernameRaw.trim() : null;

  return { telegramUserId, telegramUsername };
};

export const parseTelegramUserIdParam = (value: unknown): number => {
  const telegramUserId = parsePositiveInt(value);
  if (!telegramUserId) {
    throw new DomainError('INVALID_INPUT', 'Invalid telegram_user_id');
  }
  return telegramUserId;
};

export const ensureTelegramUserByInput = async (input: EnsureTelegramUserInput): Promise<UserRecord> => {
  return ensureTelegramUser(input.telegramUserId, input.telegramUsername);
};

export const readTelegramUserById = async (telegramUserId: number): Promise<UserRecord> => {
  const user = await getUserByTelegramId(telegramUserId);
  if (!user) {
    throw new DomainError('NOT_FOUND', 'User not found');
  }
  return user;
};

export const resetTelegramUserAccount = async (telegramUserId: number): Promise<{ ok: true }> => {
  const user = await getUserByTelegramId(telegramUserId);
  if (!user) {
    // Idempotency: Telegram may retry callback updates; if the account is already
    // deleted, treat reset as completed.
    return { ok: true };
  }

  // 1. Cancel Stripe subscription immediately
  try {
    await cancelStripeSubscriptionImmediately(String(telegramUserId));
  } catch (error: unknown) {
    console.warn('[reset_account] Failed to cancel Stripe subscription', {
      telegramUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Disconnect Google OAuth (best-effort)
  try {
    await disconnectGoogleOAuth(telegramUserId);
  } catch (error: unknown) {
    console.warn('[reset_account] Failed to disconnect Google OAuth', {
      telegramUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Destroy all assistants (containers + DB records)
  const assistants = await listAssistantsByOwnerTelegramId(telegramUserId);
  for (const assistant of assistants) {
    try {
      await removeAssistantById(assistant.id);
    } catch (error: unknown) {
      console.warn('[reset_account] Failed to remove assistant', {
        telegramUserId,
        assistantId: assistant.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 4. Delete LiteLLM key and user (best-effort)
  if (isLiteLLMClientEnabled()) {
    try {
      if (user.litellm_virtual_key) {
        await deleteLiteLLMKey([user.litellm_virtual_key]);
      }
    } catch (error: unknown) {
      console.warn('[reset_account] Failed to delete LiteLLM key', {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      if (user.litellm_user_id) {
        await deleteLiteLLMUser([user.litellm_user_id]);
      }
    } catch (error: unknown) {
      console.warn('[reset_account] Failed to delete LiteLLM user', {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 5. Delete user record (cascades to subscription_periods, sessions, etc.)
  await deleteUserByTelegramId(telegramUserId);

  return { ok: true };
};

export const removeTelegramUserById = async (telegramUserId: number): Promise<UserRecord> => {
  try {
    const deleted = await deleteTelegramUser(telegramUserId);
    if (!deleted) {
      throw new DomainError('NOT_FOUND', 'User not found');
    }
    return deleted;
  } catch (error: unknown) {
    if (error instanceof DomainError) throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('assistants')) {
      throw new DomainError('CONFLICT', message, 409, error);
    }
    throw error;
  }
};
