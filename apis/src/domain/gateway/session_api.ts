import { createGatewaySession } from '../common/db/index.js';
import { DomainError } from '../common/errors.js';

const parsePositiveInt = (value: unknown): number | null => {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const parseTtlHours = (value: unknown): number => {
  const raw = Number.parseInt(typeof value === 'string' ? value : String(value ?? ''), 10);
  if (!Number.isFinite(raw)) return 12;
  return Math.min(72, Math.max(1, raw));
};

export const createGatewaySessionByBody = async (
  body: Record<string, unknown> | undefined
): Promise<{ session_token: string; expires_at: string }> => {
  const telegramUserId = parsePositiveInt(body?.telegram_user_id);
  if (!telegramUserId) {
    throw new DomainError('INVALID_INPUT', 'telegram_user_id is required');
  }

  const ttlHours = parseTtlHours(body?.ttl_hours);
  const session = await createGatewaySession(telegramUserId, ttlHours);
  return {
    session_token: session.sessionToken,
    expires_at: session.expiresAt
  };
};
