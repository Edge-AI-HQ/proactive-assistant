import { normalizeUsername, resolveOrCreateUser } from "./userRegistry.js";
import type { PaymentStore } from "./paymentStore.js";
import {
  firstRow,
  type PaymentSessionRecord,
  type Queryable,
} from "./paymentStoreCore.js";

export const createPaymentSessionStore = (
  pool: Queryable,
): Pick<
  PaymentStore,
  | "createPaymentSession"
  | "getPaymentSessionByToken"
  | "markPaymentSessionUsed"
  | "cleanupExpiredPaymentSessions"
> => {
  return {
    async createPaymentSession(data) {
      const user = await resolveOrCreateUser(
        pool,
        data.supabase_user_id,
        data.display_name ?? null,
      );

      await pool.query(
        `
          INSERT INTO payment_sessions (
            user_id,
            session_token,
            assistant_id,
            plan_code,
            display_name_snapshot,
            expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
        `,
        [
          user.id,
          data.token,
          data.assistant_id ?? null,
          data.plan_code ?? null,
          normalizeUsername(data.display_name),
          data.expires_at,
        ],
      );
    },

    async getPaymentSessionByToken(token) {
      const result = await pool.query<PaymentSessionRecord>(
        `
          SELECT
            payment_sessions.id,
            payment_sessions.session_token AS token,
            payment_sessions.user_id,
            users.supabase_user_id::text AS supabase_user_id,
            COALESCE(payment_sessions.display_name_snapshot, users.display_name) AS display_name,
            payment_sessions.assistant_id,
            payment_sessions.plan_code,
            payment_sessions.used,
            payment_sessions.expires_at,
            payment_sessions.created_at
          FROM payment_sessions
          JOIN users
            ON users.id = payment_sessions.user_id
          WHERE payment_sessions.session_token = $1
          LIMIT 1
        `,
        [token],
      );

      return firstRow(result.rows);
    },

    async markPaymentSessionUsed(token) {
      await pool.query(
        `
          UPDATE payment_sessions
          SET
            used = TRUE,
            used_at = NOW()
          WHERE session_token = $1
            AND used = FALSE
        `,
        [token],
      );
    },

    async cleanupExpiredPaymentSessions(now = new Date()) {
      const retentionDays = 7;
      const usedRetentionCutoff = new Date(
        now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
      );
      const result = await pool.query(
        `
          DELETE FROM payment_sessions
          WHERE expires_at <= $1::timestamptz
            OR (
              used = TRUE
              AND COALESCE(used_at, created_at) <= $2::timestamptz
            )
        `,
        [now.toISOString(), usedRetentionCutoff.toISOString()],
      );
      return result.rowCount ?? 0;
    },
  };
};
