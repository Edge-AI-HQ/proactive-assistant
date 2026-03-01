import type { GatewaySessionRecord } from "../../../types.js";
import {
  fetchOne,
  nowIso,
  pool,
  randomToken,
  resolveUserIdByTelegramId,
  withSchema,
} from "./core.js";

export const createGatewaySession = async (
  telegramUserId: number,
  ttlHours: number,
): Promise<{ sessionToken: string; expiresAt: string }> => {
  await withSchema();
  const userId = await resolveUserIdByTelegramId(pool, telegramUserId);
  if (!userId) {
    throw new Error(
      `Cannot create gateway session: user ${telegramUserId} not found`,
    );
  }

  const sessionToken = randomToken(32);
  const expiresAt = new Date(
    Date.now() + ttlHours * 60 * 60 * 1000,
  ).toISOString();

  await pool.query(
    `
      INSERT INTO gateway_sessions (user_id, session_token, expires_at)
      VALUES ($1, $2, $3)
    `,
    [userId, sessionToken, expiresAt],
  );

  return { sessionToken, expiresAt };
};

export const getGatewaySession = async (
  sessionToken: string,
): Promise<GatewaySessionRecord | undefined> => {
  await withSchema();
  return fetchOne<GatewaySessionRecord>(
    pool,
    `
      SELECT
        user_sessions.id,
        users.telegram_user_id,
        user_sessions.session_token,
        user_sessions.created_at,
        user_sessions.expires_at
      FROM user_sessions
      JOIN users
        ON users.id = user_sessions.user_id
      WHERE user_sessions.session_type = 'gateway'
        AND user_sessions.session_token = $1
        AND user_sessions.expires_at > $2::timestamptz
        AND user_sessions.used = FALSE
    `,
    [sessionToken, nowIso()],
  );
};

export const cleanupExpiredGatewaySessions = async (): Promise<void> => {
  await withSchema();
  await pool.query(
    "DELETE FROM user_sessions WHERE session_type = 'gateway' AND expires_at <= $1::timestamptz",
    [nowIso()],
  );
};
