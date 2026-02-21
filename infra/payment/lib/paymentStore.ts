import { lookupUserByTelegramId, normalizeUsername, resolveOrCreateUser } from './userRegistry.js';

type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

export interface UserSubscription {
  id: number;
  user_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  stripe_customer_id: string;
  stripe_subscription_id?: string;
  plan_id?: string;
  status: 'active' | 'paused' | 'canceled' | 'pending';
  cancel_at_period_end: boolean;
  current_period_start?: string;
  current_period_end?: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentSessionRecord {
  id: number;
  token: string;
  user_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  used: boolean;
  expires_at: string;
  created_at: string;
}

export type StripeEventClaimResult = 'process' | 'skip';

export interface PaymentStore {
  upsertUserSubscription(data: {
    telegram_user_id: string;
    telegram_username?: string;
    stripe_customer_id: string;
    stripe_subscription_id?: string;
    plan_id?: string;
  }): Promise<UserSubscription>;
  getSubscriptionByTelegramId(telegram_user_id: string): Promise<UserSubscription | null>;
  getSubscriptionByStripeCustomerId(stripe_customer_id: string): Promise<UserSubscription | null>;
  getSubscriptionByStripeSubscriptionId(stripe_subscription_id: string): Promise<UserSubscription | null>;
  updateSubscriptionStatus(
    telegram_user_id: string,
    status: 'active' | 'paused' | 'canceled' | 'pending',
    period_start?: Date,
    period_end?: Date,
    cancel_at_period_end?: boolean
  ): Promise<void>;
  claimStripeEvent(data: {
    telegram_user_id?: string;
    stripe_event_id: string;
    event_type: string;
    amount?: number;
    currency?: string;
    status?: string;
    raw_data?: unknown;
  }): Promise<StripeEventClaimResult>;
  markStripeEventProcessed(stripe_event_id: string): Promise<void>;
  markStripeEventFailed(stripe_event_id: string, errorMessage: string): Promise<void>;
  getActiveSubscriptions(): Promise<UserSubscription[]>;
  createPaymentSession(data: {
    token: string;
    telegram_user_id: string;
    telegram_username?: string;
    expires_at: string;
  }): Promise<void>;
  getPaymentSessionByToken(token: string): Promise<PaymentSessionRecord | null>;
  markPaymentSessionUsed(token: string): Promise<void>;
}

const subscriptionSelectSql = `
  SELECT
    user_subscriptions.id,
    user_subscriptions.user_id,
    users.telegram_user_id::text AS telegram_user_id,
    users.telegram_username,
    user_subscriptions.stripe_customer_id,
    user_subscriptions.stripe_subscription_id,
    user_subscriptions.plan_id,
    user_subscriptions.status,
    user_subscriptions.cancel_at_period_end,
    user_subscriptions.current_period_start,
    user_subscriptions.current_period_end,
    user_subscriptions.created_at,
    user_subscriptions.updated_at
  FROM user_subscriptions
  JOIN users
    ON users.id = user_subscriptions.user_id
`;

export const createPaymentStore = (pool: Queryable): PaymentStore => {
  return {
    async upsertUserSubscription(data) {
      const user = await resolveOrCreateUser(pool, data.telegram_user_id, data.telegram_username);

      await pool.query(
        `
          INSERT INTO user_subscriptions (
            user_id,
            stripe_customer_id,
            stripe_subscription_id,
            plan_id
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id)
          DO UPDATE SET
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, user_subscriptions.stripe_subscription_id),
            plan_id = COALESCE(EXCLUDED.plan_id, user_subscriptions.plan_id),
            updated_at = NOW()
        `,
        [user.id, data.stripe_customer_id, data.stripe_subscription_id ?? null, data.plan_id ?? null]
      );

      const result = await pool.query<UserSubscription>(
        `${subscriptionSelectSql}
         WHERE user_subscriptions.user_id = $1
         LIMIT 1`,
        [user.id]
      );

      const row = firstRow(result.rows);
      if (!row) {
        throw new Error(`Failed to upsert subscription for telegram user ${data.telegram_user_id}`);
      }
      return row;
    },

    async getSubscriptionByTelegramId(telegram_user_id) {
      const user = await lookupUserByTelegramId(pool, telegram_user_id);
      if (!user) return null;

      const result = await pool.query<UserSubscription>(
        `${subscriptionSelectSql}
         WHERE user_subscriptions.user_id = $1
         LIMIT 1`,
        [user.id]
      );

      return firstRow(result.rows);
    },

    async getSubscriptionByStripeCustomerId(stripe_customer_id) {
      const result = await pool.query<UserSubscription>(
        `${subscriptionSelectSql}
         WHERE user_subscriptions.stripe_customer_id = $1
         LIMIT 1`,
        [stripe_customer_id]
      );

      return firstRow(result.rows);
    },

    async getSubscriptionByStripeSubscriptionId(stripe_subscription_id) {
      const result = await pool.query<UserSubscription>(
        `${subscriptionSelectSql}
         WHERE user_subscriptions.stripe_subscription_id = $1
         LIMIT 1`,
        [stripe_subscription_id]
      );

      return firstRow(result.rows);
    },

    async updateSubscriptionStatus(telegram_user_id, status, period_start, period_end, cancel_at_period_end) {
      const user = await lookupUserByTelegramId(pool, telegram_user_id);
      if (!user) return;

      await pool.query(
        `
          UPDATE user_subscriptions
          SET
            status = $2,
            current_period_start = $3,
            current_period_end = $4,
            cancel_at_period_end = COALESCE($5, cancel_at_period_end),
            updated_at = NOW()
          WHERE user_id = $1
        `,
        [
          user.id,
          status,
          period_start?.toISOString() ?? null,
          period_end?.toISOString() ?? null,
          cancel_at_period_end === undefined ? null : cancel_at_period_end
        ]
      );
    },

    async claimStripeEvent(data) {
      const user = data.telegram_user_id
        ? await resolveOrCreateUser(pool, data.telegram_user_id, undefined)
        : null;

      const insertResult = await pool.query<{ id: number }>(
        `
          INSERT INTO payment_events (
            user_id,
            stripe_event_id,
            event_type,
            amount,
            currency,
            status,
            processing_status,
            error_message,
            raw_data
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 'processing', NULL, $7::jsonb
          )
          ON CONFLICT (stripe_event_id) DO NOTHING
          RETURNING id
        `,
        [
          user?.id ?? null,
          data.stripe_event_id,
          data.event_type,
          data.amount ?? null,
          data.currency ?? null,
          data.status ?? null,
          JSON.stringify(data.raw_data ?? null)
        ]
      );

      if ((insertResult.rowCount ?? 0) > 0) {
        return 'process';
      }

      const reclaim = await pool.query<{ id: number }>(
        `
          UPDATE payment_events
          SET
            user_id = COALESCE($2, user_id),
            event_type = $3,
            amount = $4,
            currency = $5,
            status = $6,
            processing_status = 'processing',
            error_message = NULL,
            raw_data = $7::jsonb
          WHERE stripe_event_id = $1
            AND processing_status = 'failed'
          RETURNING id
        `,
        [
          data.stripe_event_id,
          user?.id ?? null,
          data.event_type,
          data.amount ?? null,
          data.currency ?? null,
          data.status ?? null,
          JSON.stringify(data.raw_data ?? null)
        ]
      );

      return (reclaim.rowCount ?? 0) > 0 ? 'process' : 'skip';
    },

    async markStripeEventProcessed(stripe_event_id) {
      await pool.query(
        `
          UPDATE payment_events
          SET
            processing_status = 'processed',
            error_message = NULL,
            processed_at = NOW()
          WHERE stripe_event_id = $1
        `,
        [stripe_event_id]
      );
    },

    async markStripeEventFailed(stripe_event_id, errorMessage) {
      await pool.query(
        `
          UPDATE payment_events
          SET
            processing_status = 'failed',
            error_message = $2,
            processed_at = NOW()
          WHERE stripe_event_id = $1
        `,
        [stripe_event_id, errorMessage]
      );
    },

    async getActiveSubscriptions() {
      const result = await pool.query<UserSubscription>(
        `${subscriptionSelectSql}
         WHERE user_subscriptions.status = 'active'`
      );
      return result.rows;
    },

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
    }
  };
};
