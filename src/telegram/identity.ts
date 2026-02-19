import { createGatewayToken, createUser, getUserByTelegramId, updateUser } from '../db.js';
import { containerNameForUser } from '../docker/manager.js';
import type { UserRecord } from '../types.js';

const normalizeUsername = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const ensureTelegramUser = (
  telegramUserId: number,
  telegramUsername?: string | null
): UserRecord => {
  const normalizedUsername = normalizeUsername(telegramUsername);
  const existing = getUserByTelegramId(telegramUserId);
  if (existing) {
    if (existing.telegram_username !== normalizedUsername) {
      return updateUser(telegramUserId, { telegram_username: normalizedUsername }) ?? existing;
    }
    return existing;
  }

  const containerPortPlaceholder = -Math.abs(Math.trunc(telegramUserId));

  try {
    const created = createUser({
      telegram_user_id: telegramUserId,
      telegram_username: normalizedUsername,
      container_id: containerNameForUser(telegramUserId),
      container_port: containerPortPlaceholder,
      container_status: 'idle',
      gateway_token: createGatewayToken()
    });

    if (created) return created;
  } catch (error: unknown) {
    const recovered = getUserByTelegramId(telegramUserId);
    if (recovered) return recovered;
    throw error;
  }

  const recovered = getUserByTelegramId(telegramUserId);
  if (recovered) return recovered;

  throw new Error(`Failed to create Telegram user ${telegramUserId}`);
};
