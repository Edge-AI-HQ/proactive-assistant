import { lookupUserByTelegramId } from './userRegistry.js';

export type Queryable = {
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

export type QueryExecutor = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

export const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

export const nextUtcMidnight = (from: Date): Date => {
  const next = new Date(from);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

export const clampNonNegativeInt = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
};

export const toIsoOrNull = (value: Date | undefined): string | null => {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  if (!Number.isFinite(time)) return null;
  return value.toISOString();
};

export const isUniqueViolation = (error: unknown, constraintName?: string): boolean => {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: string; constraint?: string };
  if (record.code !== '23505') return false;
  if (!constraintName) return true;
  return record.constraint === constraintName;
};

export async function withTransaction<T>(pool: Queryable, task: (client: QueryExecutor) => Promise<T>): Promise<T> {
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

export const subscriptionSelectSql = `
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

export const walletSelectSql = `
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

export const billingPlanSelectSql = `
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

export const readWalletByUserId = async (
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

export const readPlanByCode = async (queryable: QueryExecutor, planCode: string): Promise<BillingPlan | null> => {
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

export const readUserIdentityByTelegramId = async (
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
