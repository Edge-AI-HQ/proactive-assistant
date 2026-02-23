import { normalizeUsername, resolveOrCreateUser } from './userRegistry.js';
import type { PaymentStore } from './paymentStore.js';
import { firstRow, type PaymentSessionRecord, type Queryable } from './paymentStoreCore.js';

export const createPaymentSessionStore = (
  pool: Queryable
): Pick<
  PaymentStore,
  'createPaymentSession' | 'getPaymentSessionByToken' | 'markPaymentSessionUsed' | 'cleanupExpiredPaymentSessions'
> => {
  return {
    async createPaymentSession(data) {
      const user = await resolveOrCreateUser(pool, data.telegram_user_id, data.telegram_username ?? null);

      await pool.query(
        `
          INSERT INTO user_sessions (
            user_id,
            session_type,
            session_token,
            telegram_username_snapshot,
            expires_at
          ) VALUES ($1, 'payment', $2, $3, $4::timestamptz)
        `,
        [user.id, data.token, normalizeUsername(data.telegram_username), data.expires_at]
      );
    },

    async getPaymentSessionByToken(token) {
      const result = await pool.query<PaymentSessionRecord>(
        `
          SELECT
            user_sessions.id,
            user_sessions.session_token AS token,
            user_sessions.user_id,
            users.telegram_user_id::text AS telegram_user_id,
            COALESCE(user_sessions.telegram_username_snapshot, users.telegram_username) AS telegram_username,
            user_sessions.used,
            user_sessions.expires_at,
            user_sessions.created_at
          FROM user_sessions
          JOIN users
            ON users.id = user_sessions.user_id
          WHERE user_sessions.session_type = 'payment'
            AND user_sessions.session_token = $1
          LIMIT 1
        `,
        [token]
      );

      return firstRow(result.rows);
    },

    async markPaymentSessionUsed(token) {
      await pool.query(
        `
          UPDATE user_sessions
          SET
            used = TRUE,
            used_at = NOW()
          WHERE session_type = 'payment'
            AND session_token = $1
            AND used = FALSE
        `,
        [token]
      );
    },

    async cleanupExpiredPaymentSessions(now = new Date()) {
      const retentionDays = 7;
      const usedRetentionCutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
      const result = await pool.query(
        `
          DELETE FROM user_sessions
          WHERE session_type = 'payment'
            AND (
              expires_at <= $1::timestamptz
              OR (
                used = TRUE
                AND COALESCE(used_at, created_at) <= $2::timestamptz
              )
            )
        `,
        [now.toISOString(), usedRetentionCutoff.toISOString()]
      );
      return result.rowCount ?? 0;
    }
  };
};
