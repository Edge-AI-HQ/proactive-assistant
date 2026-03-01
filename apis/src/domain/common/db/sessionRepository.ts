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
        gateway_sessions.id,
        users.telegram_user_id,
        gateway_sessions.session_token,
        gateway_sessions.created_at,
        gateway_sessions.expires_at
      FROM gateway_sessions
      JOIN users
        ON users.id = gateway_sessions.user_id
      WHERE gateway_sessions.session_token = $1
        AND gateway_sessions.expires_at > NOW()
    `,
    [sessionToken],
  );
};

export const cleanupExpiredGatewaySessions = async (): Promise<number> => {
  await withSchema();
  const result = await pool.query(
    "DELETE FROM gateway_sessions WHERE expires_at < NOW() RETURNING id",
  );
  return result.rowCount ?? 0;
};
