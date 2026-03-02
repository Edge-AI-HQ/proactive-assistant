import { lookupUserByTelegramId } from "./userRegistry.js";

export type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
  connect: () => Promise<{
    query: <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: T[]; rowCount: number | null }>;
    release: () => void;
  }>;
};

export type QueryExecutor = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

export const firstRow = <T>(rows: T[]): T | null => rows[0] ?? null;

export const toIsoOrNull = (value: Date | undefined): string | null => {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  if (!Number.isFinite(time)) return null;
  return value.toISOString();
};

export interface UserSubscription {
  id: number;
  user_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  stripe_customer_id: string;
  stripe_subscription_id?: string;
  plan_id?: string;
  status:
    | "incomplete"
    | "incomplete_expired"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "paused";
  stripe_status?: string;
  cancel_at_period_end: boolean;
  current_period_start?: string;
  current_period_end?: string;
  ended_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentSessionRecord {
  id: number;
  token: string;
  user_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  assistant_id?: number | null;
  plan_code?: string | null;
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

export type StripeEventClaimResult = "process" | "skip";

/** 订阅周期：每个 Stripe 计费周期一行；当前生效 = period_start <= now() < period_end */
export interface SubscriptionPeriod {
  id: number;
  user_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
  stripe_invoice_id: string | null;
  period_start: string;
  period_end: string;
  plan_id: string;
  status: string;
  cancel_at_period_end: boolean;
  budget_applied_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 当前生效周期视图：供 subscriptionGuard / checkout / litellmBudget 使用，与「按时间判定生效」一致 */
export interface CurrentSubscriptionView {
  telegram_user_id: string;
  telegram_username: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string;
  plan_id: string | null;
  status: string;
  cancel_at_period_end: boolean;
  current_period_start: string;
  current_period_end: string;
}

/** 从 Stripe 解析出的订阅方信息（用于 invoice 等） */
export interface SubscriptionInfoByStripe {
  telegram_user_id: string;
  telegram_username: string | null;
  stripe_subscription_id: string;
  plan_id: string | null;
}

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

export const readPlanByCode = async (
  queryable: QueryExecutor,
  planCode: string,
): Promise<BillingPlan | null> => {
  const result = await queryable.query<BillingPlan>(
    `
      ${billingPlanSelectSql}
      WHERE plan_code = $1
      LIMIT 1
    `,
    [planCode],
  );
  return firstRow(result.rows);
};

export const readUserIdentityByTelegramId = async (
  queryable: QueryExecutor,
  telegramUserId: string,
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
    [user.id],
  );

  return firstRow(result.rows);
};
