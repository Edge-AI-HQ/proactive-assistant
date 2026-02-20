type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

export interface UserSubscription {
  id: number;
  telegram_user_id: string;
  telegram_username?: string;
  stripe_customer_id: string;
  stripe_subscription_id?: string;
  docker_container_id?: string;
  docker_port?: number;
  docker_url?: string;
  status: 'active' | 'paused' | 'canceled' | 'pending';
  current_period_start?: string;
  current_period_end?: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentSessionRecord {
  id: number;
  token: string;
  telegram_user_id: string;
  telegram_username: string | null;
  used: boolean;
  expires_at: string;
  created_at: string;
}

export interface PaymentStore {
  upsertUserSubscription(data: {
    telegram_user_id: string;
    telegram_username?: string;
    stripe_customer_id: string;
    stripe_subscription_id?: string;
  }): Promise<UserSubscription>;
  getSubscriptionByTelegramId(telegram_user_id: string): Promise<UserSubscription | null>;
  getSubscriptionByStripeCustomerId(stripe_customer_id: string): Promise<UserSubscription | null>;
  getSubscriptionByStripeSubscriptionId(stripe_subscription_id: string): Promise<UserSubscription | null>;
  updateSubscriptionStatus(
    telegram_user_id: string,
    status: 'active' | 'paused' | 'canceled' | 'pending',
    period_start?: Date,
    period_end?: Date
  ): Promise<void>;
  updateDockerInfo(telegram_user_id: string, container_id: string, port: number, url: string): Promise<void>;
  logPaymentEvent(data: {
    telegram_user_id?: string;
    stripe_event_id: string;
    event_type: string;
    amount?: number;
    currency?: string;
    status?: string;
    raw_data?: unknown;
  }): Promise<void>;
  logContainerAction(
    telegram_user_id: string,
    container_id: string,
    action: 'created' | 'started' | 'stopped' | 'removed' | 'error',
    message?: string
  ): Promise<void>;
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

export const createPaymentStore = (pool: Queryable): PaymentStore => {
  return {
    async upsertUserSubscription(data) {
      const result = await pool.query<UserSubscription>(
        `
          INSERT INTO user_subscriptions (
            telegram_user_id,
            telegram_username,
            stripe_customer_id,
            stripe_subscription_id
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT (telegram_user_id)
          DO UPDATE SET
            telegram_username = COALESCE(EXCLUDED.telegram_username, user_subscriptions.telegram_username),
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, user_subscriptions.stripe_subscription_id),
            updated_at = NOW()
          RETURNING *
        `,
        [
          data.telegram_user_id,
          data.telegram_username ?? null,
          data.stripe_customer_id,
          data.stripe_subscription_id ?? null
        ]
      );

      const row = firstRow(result.rows);
      if (!row) {
        throw new Error(`Failed to upsert subscription for telegram user ${data.telegram_user_id}`);
      }
      return row;
    },

    async getSubscriptionByTelegramId(telegram_user_id) {
      const result = await pool.query<UserSubscription>(
        `
          SELECT *
          FROM user_subscriptions
          WHERE telegram_user_id = $1
          LIMIT 1
        `,
        [telegram_user_id]
      );

      return firstRow(result.rows);
    },

    async getSubscriptionByStripeCustomerId(stripe_customer_id) {
      const result = await pool.query<UserSubscription>(
        `
          SELECT *
          FROM user_subscriptions
          WHERE stripe_customer_id = $1
          LIMIT 1
        `,
        [stripe_customer_id]
      );

      return firstRow(result.rows);
    },

    async getSubscriptionByStripeSubscriptionId(stripe_subscription_id) {
      const result = await pool.query<UserSubscription>(
        `
          SELECT *
          FROM user_subscriptions
          WHERE stripe_subscription_id = $1
          LIMIT 1
        `,
        [stripe_subscription_id]
      );

      return firstRow(result.rows);
    },

    async updateSubscriptionStatus(telegram_user_id, status, period_start, period_end) {
      await pool.query(
        `
          UPDATE user_subscriptions
          SET
            status = $2,
            current_period_start = $3,
            current_period_end = $4,
            updated_at = NOW()
          WHERE telegram_user_id = $1
        `,
        [telegram_user_id, status, period_start?.toISOString() ?? null, period_end?.toISOString() ?? null]
      );
    },

    async updateDockerInfo(telegram_user_id, container_id, port, url) {
      await pool.query(
        `
          UPDATE user_subscriptions
          SET
            docker_container_id = $2,
            docker_port = $3,
            docker_url = $4,
            updated_at = NOW()
          WHERE telegram_user_id = $1
        `,
        [telegram_user_id, container_id, port, url]
      );
    },

    async logPaymentEvent(data) {
      await pool.query(
        `
          INSERT INTO payment_events (
            telegram_user_id,
            stripe_event_id,
            event_type,
            amount,
            currency,
            status,
            raw_data
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          ON CONFLICT (stripe_event_id) DO NOTHING
        `,
        [
          data.telegram_user_id ?? null,
          data.stripe_event_id,
          data.event_type,
          data.amount ?? null,
          data.currency ?? null,
          data.status ?? null,
          JSON.stringify(data.raw_data ?? null)
        ]
      );
    },

    async logContainerAction(telegram_user_id, container_id, action, message) {
      await pool.query(
        `
          INSERT INTO container_logs (
            telegram_user_id,
            container_id,
            action,
            message
          ) VALUES ($1, $2, $3, $4)
        `,
        [telegram_user_id, container_id, action, message ?? null]
      );
    },

    async getActiveSubscriptions() {
      const result = await pool.query<UserSubscription>(
        `
          SELECT *
          FROM user_subscriptions
          WHERE status = 'active'
        `
      );
      return result.rows;
    },

    async createPaymentSession(data) {
      await pool.query(
        `
          INSERT INTO payment_sessions (
            token,
            telegram_user_id,
            telegram_username,
            expires_at
          ) VALUES ($1, $2, $3, $4::timestamptz)
        `,
        [data.token, data.telegram_user_id, data.telegram_username ?? null, data.expires_at]
      );
    },

    async getPaymentSessionByToken(token) {
      const result = await pool.query<PaymentSessionRecord>(
        `
          SELECT *
          FROM payment_sessions
          WHERE token = $1
          LIMIT 1
        `,
        [token]
      );

      return firstRow(result.rows);
    },

    async markPaymentSessionUsed(token) {
      await pool.query(
        `
          UPDATE payment_sessions
          SET used = TRUE
          WHERE token = $1
        `,
        [token]
      );
    }
  };
};
