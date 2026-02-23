import crypto from 'crypto';

type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

export interface ResolvedUser {
  id: number;
  telegram_user_id: string;
  telegram_username: string | null;
}

export const parseTelegramUserId = (value: string): number => {
  const trimmed = String(value || '').trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('telegram_user_id must be a positive integer string');
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('telegram_user_id is out of supported range');
  }

  return parsed;
};

export const normalizeUsername = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const buildUserGatewayToken = (): string => crypto.randomBytes(24).toString('hex');

export const resolveOrCreateUser = async (
  pool: Queryable,
  telegram_user_id: string,
  telegram_username?: string | null
): Promise<ResolvedUser> => {
  const parsedTelegramId = parseTelegramUserId(telegram_user_id);
  const username = normalizeUsername(telegram_username);

  const result = await pool.query<{ id: number; telegram_user_id: number; telegram_username: string | null }>(
    `
      INSERT INTO users (
        telegram_user_id,
        telegram_username,
        gateway_token,
        updated_at,
        last_active_at
      ) VALUES (
        $1,
        $2,
        $3,
        NOW(),
        NOW()
      )
      ON CONFLICT (telegram_user_id)
      DO UPDATE SET
        telegram_username = COALESCE(EXCLUDED.telegram_username, users.telegram_username),
        updated_at = NOW(),
        last_active_at = NOW()
      RETURNING id, telegram_user_id, telegram_username
    `,
    [parsedTelegramId, username, buildUserGatewayToken()]
  );

  const user = firstRow(result.rows);
  if (!user) {
    throw new Error(`Failed to upsert user ${telegram_user_id}`);
  }

  return {
    id: user.id,
    telegram_user_id: String(user.telegram_user_id),
    telegram_username: user.telegram_username
  };
};

export const lookupUserByTelegramId = async (
  pool: Queryable,
  telegram_user_id: string
): Promise<ResolvedUser | null> => {
  const parsedTelegramId = parseTelegramUserId(telegram_user_id);

  const result = await pool.query<{ id: number; telegram_user_id: number; telegram_username: string | null }>(
    `
      SELECT id, telegram_user_id, telegram_username
      FROM users
      WHERE telegram_user_id = $1
      LIMIT 1
    `,
    [parsedTelegramId]
  );

  const row = firstRow(result.rows);
  if (!row) return null;

  return {
    id: row.id,
    telegram_user_id: String(row.telegram_user_id),
    telegram_username: row.telegram_username
  };
};
