import { lookupUserByTelegramId, normalizeUsername, resolveOrCreateUser } from './userRegistry.js';

type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
  connect: () => Promise<{
    query: <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[]
    ) => Promise<{ rows: T[]; rowCount: number | null }>;
    release: () => void;
  }>;
};

type QueryExecutor = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

const nextUtcMidnight = (from: Date): Date => {
  const next = new Date(from);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const clampNonNegativeInt = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
};

const isUniqueViolation = (error: unknown, constraintName?: string): boolean => {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: string; constraint?: string };
  if (record.code !== '23505') return false;
  if (!constraintName) return true;
  return record.constraint === constraintName;
};

async function withTransaction<T>(pool: Queryable, task: (client: QueryExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

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

export interface BillingPlan {
  plan_code: string;
  display_name: string;
  stripe_price_id: string;
  currency: string;
  price_cents_monthly: number;
  daily_refresh_credits: number;
  monthly_refresh_credits: number;
  sort_order: number;
  is_active: boolean;
}

export interface UserIdentity {
  id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  litellm_user_id: string | null;
  litellm_user_alias: string | null;
}

export interface UserCreditWallet {
  id: number;
  user_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  plan_code: string;
  daily_credits_remaining: number;
  monthly_credits_remaining: number;
  next_daily_refresh_at: string;
  next_monthly_refresh_at: string;
  last_litellm_spend_cents: number;
  created_at: string;
  updated_at: string;
}

export interface CreditMutationResult {
  wallet: UserCreditWallet | null;
  applied: boolean;
  credits_increased: number;
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
  listActivePlans(): Promise<BillingPlan[]>;
  getPlanByCode(planCode: string): Promise<BillingPlan | null>;
  getPlanByStripePriceId(stripePriceId: string): Promise<BillingPlan | null>;
  getUserIdentityByTelegramId(telegram_user_id: string): Promise<UserIdentity | null>;
  upsertUserLiteLLMIdentity(data: {
    telegram_user_id: string;
    telegram_username?: string | null;
    litellm_user_id: string;
    litellm_user_alias?: string | null;
  }): Promise<UserIdentity>;
  getWalletByUserId(user_id: number): Promise<UserCreditWallet | null>;
  upsertWalletPlanContext(data: {
    telegram_user_id: string;
    telegram_username?: string | null;
    plan_id: string;
    next_monthly_refresh_at: Date;
  }): Promise<UserCreditWallet>;
  applyMonthlyCreditsRefresh(data: {
    telegram_user_id: string;
    telegram_username?: string | null;
    plan_id: string;
    next_monthly_refresh_at: Date;
    idempotency_key: string;
    source: string;
    metadata?: unknown;
  }): Promise<CreditMutationResult>;
  listUsersDueDailyCreditRefresh(limit: number, now?: Date): Promise<Array<{ user_id: number }>>;
  refreshDailyCreditsByUserId(data: {
    user_id: number;
    idempotency_key: string;
    source: string;
    now?: Date;
    metadata?: unknown;
  }): Promise<CreditMutationResult>;
  applyUsageDebitByUserId(data: {
    user_id: number;
    litellm_spend_cents: number;
    idempotency_key: string;
    source: string;
    metadata?: unknown;
  }): Promise<CreditMutationResult>;
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

const walletSelectSql = `
  SELECT
    user_credit_wallets.id,
    user_credit_wallets.user_id,
    users.telegram_user_id::text AS telegram_user_id,
    users.telegram_username,
    user_credit_wallets.plan_code,
    user_credit_wallets.daily_credits_remaining,
    user_credit_wallets.monthly_credits_remaining,
    user_credit_wallets.next_daily_refresh_at,
    user_credit_wallets.next_monthly_refresh_at,
    user_credit_wallets.last_litellm_spend_cents,
    user_credit_wallets.created_at,
    user_credit_wallets.updated_at
  FROM user_credit_wallets
  JOIN users
    ON users.id = user_credit_wallets.user_id
`;

const billingPlanSelectSql = `
  SELECT
    plan_code,
    display_name,
    stripe_price_id,
    currency,
    price_cents_monthly,
    daily_refresh_credits,
    monthly_refresh_credits,
    sort_order,
    is_active
  FROM billing_plans
`;

const readWalletByUserId = async (
  queryable: QueryExecutor,
  userId: number,
  forUpdate = false
): Promise<UserCreditWallet | null> => {
  const result = await queryable.query<UserCreditWallet>(
    `${walletSelectSql}
     WHERE user_credit_wallets.user_id = $1
     ${forUpdate ? 'FOR UPDATE' : ''}
     LIMIT 1`,
    [userId]
  );
  return firstRow(result.rows);
};

const readPlanByCode = async (queryable: QueryExecutor, planCode: string): Promise<BillingPlan | null> => {
  const result = await queryable.query<BillingPlan>(
    `
      ${billingPlanSelectSql}
      WHERE plan_code = $1
      LIMIT 1
    `,
    [planCode]
  );
  return firstRow(result.rows);
};

const readUserIdentityByTelegramId = async (
  queryable: QueryExecutor,
  telegramUserId: string
): Promise<UserIdentity | null> => {
  const user = await lookupUserByTelegramId(queryable, telegramUserId);
  if (!user) return null;

  const result = await queryable.query<UserIdentity>(
    `
      SELECT
        id,
        telegram_user_id::text,
        telegram_username,
        litellm_user_id,
        litellm_user_alias
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [user.id]
  );

  return firstRow(result.rows);
};

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
    },

    async listActivePlans() {
      const result = await pool.query<BillingPlan>(
        `
          ${billingPlanSelectSql}
          WHERE is_active = TRUE
          ORDER BY sort_order ASC, plan_code ASC
        `
      );
      return result.rows;
    },

    async getPlanByCode(planCode) {
      return readPlanByCode(pool, planCode);
    },

    async getPlanByStripePriceId(stripePriceId) {
      const result = await pool.query<BillingPlan>(
        `
          ${billingPlanSelectSql}
          WHERE stripe_price_id = $1
          LIMIT 1
        `,
        [stripePriceId]
      );
      return firstRow(result.rows);
    },

    async getUserIdentityByTelegramId(telegram_user_id) {
      return readUserIdentityByTelegramId(pool, telegram_user_id);
    },

    async upsertUserLiteLLMIdentity(data) {
      const user = await resolveOrCreateUser(pool, data.telegram_user_id, data.telegram_username);
      const litellmUserId = data.litellm_user_id.trim();
      const litellmAlias = normalizeUsername(data.litellm_user_alias);

      const result = await pool.query<UserIdentity>(
        `
          UPDATE users
          SET
            litellm_user_id = $2,
            litellm_user_alias = COALESCE($3, litellm_user_alias),
            updated_at = NOW(),
            last_active_at = NOW()
          WHERE id = $1
          RETURNING
            id,
            telegram_user_id::text,
            telegram_username,
            litellm_user_id,
            litellm_user_alias
        `,
        [user.id, litellmUserId, litellmAlias]
      );

      const updated = firstRow(result.rows);
      if (!updated) {
        throw new Error(`Failed to update LiteLLM identity for telegram user ${data.telegram_user_id}`);
      }

      return updated;
    },

    async getWalletByUserId(user_id) {
      return readWalletByUserId(pool, user_id);
    },

    async upsertWalletPlanContext(data) {
      const user = await resolveOrCreateUser(pool, data.telegram_user_id, data.telegram_username);
      const plan = await readPlanByCode(pool, data.plan_id);
      if (!plan) {
        throw new Error(`Unknown plan_id: ${data.plan_id}`);
      }

      const now = new Date();
      const nextDaily = nextUtcMidnight(now);

      await pool.query(
        `
          INSERT INTO user_credit_wallets (
            user_id,
            plan_code,
            daily_credits_remaining,
            monthly_credits_remaining,
            next_daily_refresh_at,
            next_monthly_refresh_at
          ) VALUES (
            $1, $2, 0, 0, $3::timestamptz, $4::timestamptz
          )
          ON CONFLICT (user_id)
          DO UPDATE SET
            plan_code = EXCLUDED.plan_code,
            next_monthly_refresh_at = EXCLUDED.next_monthly_refresh_at,
            updated_at = NOW()
        `,
        [user.id, plan.plan_code, nextDaily.toISOString(), data.next_monthly_refresh_at.toISOString()]
      );

      const wallet = await readWalletByUserId(pool, user.id);
      if (!wallet) {
        throw new Error(`Failed to upsert wallet context for user ${data.telegram_user_id}`);
      }

      return wallet;
    },

    async applyMonthlyCreditsRefresh(data) {
      try {
        return await withTransaction(pool, async (tx) => {
          const existingLedger = await tx.query<{ id: number }>(
            'SELECT id FROM credit_ledger WHERE idempotency_key = $1 LIMIT 1',
            [data.idempotency_key]
          );
          if (firstRow(existingLedger.rows)) {
            const user = await lookupUserByTelegramId(tx, data.telegram_user_id);
            if (!user) {
              return { wallet: null, applied: false, credits_increased: 0 };
            }
            const wallet = await readWalletByUserId(tx, user.id);
            return {
              wallet,
              applied: false,
              credits_increased: 0
            };
          }

          const user = await resolveOrCreateUser(tx, data.telegram_user_id, data.telegram_username);
          const plan = await readPlanByCode(tx, data.plan_id);
          if (!plan) {
            throw new Error(`Unknown plan_id: ${data.plan_id}`);
          }

          const walletBefore = await readWalletByUserId(tx, user.id, true);
          const beforeTotal =
            (walletBefore?.daily_credits_remaining ?? 0) + (walletBefore?.monthly_credits_remaining ?? 0);

          const now = new Date();
          const nextDaily = nextUtcMidnight(now).toISOString();
          const nextMonthly = data.next_monthly_refresh_at.toISOString();

          if (!walletBefore) {
            await tx.query(
              `
                INSERT INTO user_credit_wallets (
                  user_id,
                  plan_code,
                  daily_credits_remaining,
                  monthly_credits_remaining,
                  next_daily_refresh_at,
                  next_monthly_refresh_at
                ) VALUES (
                  $1, $2, $3, $4, $5::timestamptz, $6::timestamptz
                )
              `,
              [
                user.id,
                plan.plan_code,
                plan.daily_refresh_credits,
                plan.monthly_refresh_credits,
                nextDaily,
                nextMonthly
              ]
            );
          } else {
            await tx.query(
              `
                UPDATE user_credit_wallets
                SET
                  plan_code = $2,
                  daily_credits_remaining = $3,
                  monthly_credits_remaining = $4,
                  next_daily_refresh_at = $5::timestamptz,
                  next_monthly_refresh_at = $6::timestamptz,
                  updated_at = NOW()
                WHERE user_id = $1
              `,
              [
                user.id,
                plan.plan_code,
                plan.daily_refresh_credits,
                plan.monthly_refresh_credits,
                nextDaily,
                nextMonthly
              ]
            );
          }

          const walletAfter = await readWalletByUserId(tx, user.id);
          if (!walletAfter) {
            throw new Error(`Failed to refresh wallet for user ${data.telegram_user_id}`);
          }

          const deltaDaily = walletAfter.daily_credits_remaining - (walletBefore?.daily_credits_remaining ?? 0);
          const deltaMonthly = walletAfter.monthly_credits_remaining - (walletBefore?.monthly_credits_remaining ?? 0);

          await tx.query(
            `
              INSERT INTO credit_ledger (
                user_id,
                event_type,
                delta_daily_credits,
                delta_monthly_credits,
                daily_credits_after,
                monthly_credits_after,
                idempotency_key,
                source,
                metadata
              ) VALUES (
                $1, 'monthly_refresh', $2, $3, $4, $5, $6, $7, $8::jsonb
              )
            `,
            [
              user.id,
              deltaDaily,
              deltaMonthly,
              walletAfter.daily_credits_remaining,
              walletAfter.monthly_credits_remaining,
              data.idempotency_key,
              data.source,
              JSON.stringify(data.metadata ?? null)
            ]
          );

          const afterTotal = walletAfter.daily_credits_remaining + walletAfter.monthly_credits_remaining;
          const creditsIncreased = clampNonNegativeInt(afterTotal - beforeTotal);

          return {
            wallet: walletAfter,
            applied: true,
            credits_increased: creditsIncreased
          };
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error, 'credit_ledger_idempotency_key_key')) {
          const user = await lookupUserByTelegramId(pool, data.telegram_user_id);
          if (!user) {
            return { wallet: null, applied: false, credits_increased: 0 };
          }
          const wallet = await readWalletByUserId(pool, user.id);
          return { wallet, applied: false, credits_increased: 0 };
        }
        throw error;
      }
    },

    async listUsersDueDailyCreditRefresh(limit, now = new Date()) {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit || 50)));
      const result = await pool.query<{ user_id: number }>(
        `
          SELECT user_credit_wallets.user_id
          FROM user_credit_wallets
          JOIN user_subscriptions
            ON user_subscriptions.user_id = user_credit_wallets.user_id
          WHERE user_subscriptions.status = 'active'
            AND user_credit_wallets.next_daily_refresh_at <= $1::timestamptz
          ORDER BY user_credit_wallets.next_daily_refresh_at ASC
          LIMIT $2
        `,
        [now.toISOString(), safeLimit]
      );

      return result.rows;
    },

    async refreshDailyCreditsByUserId(data) {
      try {
        return await withTransaction(pool, async (tx) => {
          const existingLedger = await tx.query<{ id: number }>(
            'SELECT id FROM credit_ledger WHERE idempotency_key = $1 LIMIT 1',
            [data.idempotency_key]
          );
          if (firstRow(existingLedger.rows)) {
            const wallet = await readWalletByUserId(tx, data.user_id);
            return { wallet, applied: false, credits_increased: 0 };
          }

          const now = data.now ?? new Date();

          const contextResult = await tx.query<{
            user_id: number;
            subscription_status: string | null;
            plan_code: string;
            daily_credits_remaining: number;
            monthly_credits_remaining: number;
            next_daily_refresh_at: string;
            plan_daily_refresh_credits: number;
          }>(
            `
              SELECT
                user_credit_wallets.user_id,
                user_subscriptions.status AS subscription_status,
                user_credit_wallets.plan_code,
                user_credit_wallets.daily_credits_remaining,
                user_credit_wallets.monthly_credits_remaining,
                user_credit_wallets.next_daily_refresh_at,
                billing_plans.daily_refresh_credits AS plan_daily_refresh_credits
              FROM user_credit_wallets
              JOIN billing_plans
                ON billing_plans.plan_code = user_credit_wallets.plan_code
              LEFT JOIN user_subscriptions
                ON user_subscriptions.user_id = user_credit_wallets.user_id
              WHERE user_credit_wallets.user_id = $1
              FOR UPDATE
              LIMIT 1
            `,
            [data.user_id]
          );

          const context = firstRow(contextResult.rows);
          if (!context) {
            return { wallet: null, applied: false, credits_increased: 0 };
          }

          if ((context.subscription_status || 'pending') !== 'active') {
            const wallet = await readWalletByUserId(tx, data.user_id);
            return { wallet, applied: false, credits_increased: 0 };
          }

          if (new Date(context.next_daily_refresh_at) > now) {
            const wallet = await readWalletByUserId(tx, data.user_id);
            return { wallet, applied: false, credits_increased: 0 };
          }

          const targetDaily = clampNonNegativeInt(context.plan_daily_refresh_credits);
          const nextDaily = nextUtcMidnight(now).toISOString();

          await tx.query(
            `
              UPDATE user_credit_wallets
              SET
                daily_credits_remaining = $2,
                next_daily_refresh_at = $3::timestamptz,
                updated_at = NOW()
              WHERE user_id = $1
            `,
            [data.user_id, targetDaily, nextDaily]
          );

          const walletAfter = await readWalletByUserId(tx, data.user_id);
          if (!walletAfter) {
            throw new Error(`Failed to refresh daily credits for user ${data.user_id}`);
          }

          const deltaDaily = walletAfter.daily_credits_remaining - context.daily_credits_remaining;
          await tx.query(
            `
              INSERT INTO credit_ledger (
                user_id,
                event_type,
                delta_daily_credits,
                delta_monthly_credits,
                daily_credits_after,
                monthly_credits_after,
                idempotency_key,
                source,
                metadata
              ) VALUES (
                $1, 'daily_refresh', $2, 0, $3, $4, $5, $6, $7::jsonb
              )
            `,
            [
              data.user_id,
              deltaDaily,
              walletAfter.daily_credits_remaining,
              walletAfter.monthly_credits_remaining,
              data.idempotency_key,
              data.source,
              JSON.stringify(data.metadata ?? null)
            ]
          );

          return {
            wallet: walletAfter,
            applied: true,
            credits_increased: clampNonNegativeInt(deltaDaily)
          };
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error, 'credit_ledger_idempotency_key_key')) {
          const wallet = await readWalletByUserId(pool, data.user_id);
          return { wallet, applied: false, credits_increased: 0 };
        }
        throw error;
      }
    },

    async applyUsageDebitByUserId(data) {
      try {
        return await withTransaction(pool, async (tx) => {
          const existingLedger = await tx.query<{ id: number }>(
            'SELECT id FROM credit_ledger WHERE idempotency_key = $1 LIMIT 1',
            [data.idempotency_key]
          );
          if (firstRow(existingLedger.rows)) {
            const wallet = await readWalletByUserId(tx, data.user_id);
            return { wallet, applied: false, credits_increased: 0 };
          }

          const walletBefore = await readWalletByUserId(tx, data.user_id, true);
          if (!walletBefore) {
            return { wallet: null, applied: false, credits_increased: 0 };
          }

          const targetSpendCents = clampNonNegativeInt(data.litellm_spend_cents);
          const currentSpendCents = clampNonNegativeInt(walletBefore.last_litellm_spend_cents);
          const spendDelta = Math.max(0, targetSpendCents - currentSpendCents);

          if (spendDelta <= 0) {
            return { wallet: walletBefore, applied: false, credits_increased: 0 };
          }

          const debitFromDaily = Math.min(walletBefore.daily_credits_remaining, spendDelta);
          const remainingAfterDaily = spendDelta - debitFromDaily;
          const debitFromMonthly = Math.min(walletBefore.monthly_credits_remaining, remainingAfterDaily);

          const nextDaily = walletBefore.daily_credits_remaining - debitFromDaily;
          const nextMonthly = walletBefore.monthly_credits_remaining - debitFromMonthly;

          await tx.query(
            `
              UPDATE user_credit_wallets
              SET
                daily_credits_remaining = $2,
                monthly_credits_remaining = $3,
                last_litellm_spend_cents = $4,
                updated_at = NOW()
              WHERE user_id = $1
            `,
            [data.user_id, nextDaily, nextMonthly, targetSpendCents]
          );

          const walletAfter = await readWalletByUserId(tx, data.user_id);
          if (!walletAfter) {
            throw new Error(`Failed to apply usage debit for user ${data.user_id}`);
          }

          await tx.query(
            `
              INSERT INTO credit_ledger (
                user_id,
                event_type,
                delta_daily_credits,
                delta_monthly_credits,
                daily_credits_after,
                monthly_credits_after,
                idempotency_key,
                source,
                metadata
              ) VALUES (
                $1, 'usage_debit', $2, $3, $4, $5, $6, $7, $8::jsonb
              )
            `,
            [
              data.user_id,
              -debitFromDaily,
              -debitFromMonthly,
              walletAfter.daily_credits_remaining,
              walletAfter.monthly_credits_remaining,
              data.idempotency_key,
              data.source,
              JSON.stringify({
                ...(typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {}),
                litellm_spend_cents_before: currentSpendCents,
                litellm_spend_cents_after: targetSpendCents
              })
            ]
          );

          return { wallet: walletAfter, applied: true, credits_increased: 0 };
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error, 'credit_ledger_idempotency_key_key')) {
          const wallet = await readWalletByUserId(pool, data.user_id);
          return { wallet, applied: false, credits_increased: 0 };
        }
        throw error;
      }
    }
  };
};
