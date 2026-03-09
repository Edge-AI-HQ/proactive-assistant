import { pool } from "../common/db/core.js";

type PlanBudgetRow = {
  plan_id: string | null;
  plan_name: string | null;
  monthly_refresh_credits: number | null;
  price_cents_monthly: number | null;
  subscribed_users: string;
  litellm_budget_usd_sum: string | null;
};

type UserIdRow = {
  telegram_user_id: string;
};

const SERVICE_ACTIVE_STATUSES = ["active", "trialing", "past_due"] as const;

const toNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const toRounded = (value: number): number => Math.round(value * 100) / 100;

const readStripeSubscriptionSnapshotFromDb = async (): Promise<{
  total: number;
  service_active: number;
  by_status: Record<string, number>;
}> => {
  type StripeStatusRow = { status: string | null; count: string };
  const rows = await pool.query<StripeStatusRow>(
    `
      SELECT
        status,
        COUNT(*)::text AS count
      FROM user_subscriptions
      WHERE stripe_subscription_id IS NOT NULL
      GROUP BY status
    `,
  );

  const byStatus: Record<string, number> = {};
  let total = 0;
  let serviceActive = 0;
  for (const row of rows.rows) {
    const status = (row.status || "unknown").trim() || "unknown";
    const count = toNumber(row.count);
    byStatus[status] = count;
    total += count;
    if (SERVICE_ACTIVE_STATUSES.includes(status as (typeof SERVICE_ACTIVE_STATUSES)[number])) {
      serviceActive += count;
    }
  }

  return {
    total,
    service_active: serviceActive,
    by_status: byStatus,
  };
};

const readServiceActiveUsers = async (): Promise<Set<string>> => {
  const result = await pool.query<UserIdRow>(
    `
      SELECT DISTINCT u.telegram_user_id::text AS telegram_user_id
      FROM subscription_periods sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.period_start <= NOW()
        AND sp.period_end > NOW()
        AND sp.plan_id IS NOT NULL
        AND sp.status = ANY($1::text[])
    `,
    [SERVICE_ACTIVE_STATUSES],
  );
  return new Set(result.rows.map((row) => row.telegram_user_id));
};

const readRunningContainerUsers = async (): Promise<Set<string>> => {
  const result = await pool.query<UserIdRow>(
    `
      SELECT DISTINCT u.telegram_user_id::text AS telegram_user_id
      FROM runtime_instances r
      JOIN assistants a ON a.id = r.assistant_id
      JOIN users u ON u.id = a.owner_user_id
      WHERE r.scope = 'assistant'
        AND r.status = 'running'
    `,
  );
  return new Set(result.rows.map((row) => row.telegram_user_id));
};

const readPlanBudgetRows = async (): Promise<PlanBudgetRow[]> => {
  const result = await pool.query<PlanBudgetRow>(
    `
      WITH active AS (
        SELECT DISTINCT sp.user_id, sp.plan_id
        FROM subscription_periods sp
        WHERE sp.period_start <= NOW()
          AND sp.period_end > NOW()
          AND sp.plan_id IS NOT NULL
          AND sp.status = ANY($1::text[])
      )
      SELECT
        a.plan_id,
        bp.display_name AS plan_name,
        bp.monthly_refresh_credits,
        bp.price_cents_monthly,
        COUNT(DISTINCT a.user_id)::text AS subscribed_users,
        COALESCE(SUM(u.litellm_budget_usd), 0)::text AS litellm_budget_usd_sum
      FROM active a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN billing_plans bp ON bp.plan_code = a.plan_id
      GROUP BY a.plan_id, bp.display_name, bp.monthly_refresh_credits, bp.price_cents_monthly
      ORDER BY a.plan_id
    `,
    [SERVICE_ACTIVE_STATUSES],
  );
  return result.rows;
};

const sampleFromSetDifference = (
  left: Set<string>,
  right: Set<string>,
  sampleSize = 20,
): string[] => {
  const sample: string[] = [];
  for (const item of left) {
    if (right.has(item)) continue;
    sample.push(item);
    if (sample.length >= sampleSize) break;
  }
  return sample;
};

export const buildCaptainReport = async (): Promise<Record<string, unknown>> => {
  const [stripeSnapshot, serviceActiveUsers, runningContainerUsers, planRows] =
    await Promise.all([
      readStripeSubscriptionSnapshotFromDb(),
      readServiceActiveUsers(),
      readRunningContainerUsers(),
      readPlanBudgetRows(),
    ]);

  const byPlan = planRows.map((row) => {
    const users = toNumber(row.subscribed_users);
    const credits = toNumber(row.monthly_refresh_credits);
    const expectedBudgetUsd = toRounded((users * credits) / 100);
    const litellmBudgetUsd = toRounded(toNumber(row.litellm_budget_usd_sum));
    return {
      plan_id: row.plan_id,
      plan_name: row.plan_name,
      subscribed_users: users,
      monthly_refresh_credits: credits,
      expected_budget_usd: expectedBudgetUsd,
      litellm_budget_usd_sum: litellmBudgetUsd,
      budget_delta_usd: toRounded(litellmBudgetUsd - expectedBudgetUsd),
      price_cents_monthly: toNumber(row.price_cents_monthly),
      mrr_usd: toRounded((toNumber(row.price_cents_monthly) * users) / 100),
    };
  });

  const expectedBudgetTotal = toRounded(
    byPlan.reduce((sum, row) => sum + toNumber(row.expected_budget_usd), 0),
  );
  const litellmBudgetTotal = toRounded(
    byPlan.reduce((sum, row) => sum + toNumber(row.litellm_budget_usd_sum), 0),
  );

  const subscribedWithoutRunning = sampleFromSetDifference(
    serviceActiveUsers,
    runningContainerUsers,
  );
  const runningWithoutSubscribed = sampleFromSetDifference(
    runningContainerUsers,
    serviceActiveUsers,
  );

  return {
    generated_at: new Date().toISOString(),
    stripe: {
      ...stripeSnapshot,
      source: "db_user_subscriptions",
    },
    system: {
      service_active_subscription_users: serviceActiveUsers.size,
      running_container_users: runningContainerUsers.size,
      delta_users: runningContainerUsers.size - serviceActiveUsers.size,
    },
    budget_cross_check: {
      expected_budget_usd_total: expectedBudgetTotal,
      litellm_budget_usd_total: litellmBudgetTotal,
      total_delta_usd: toRounded(litellmBudgetTotal - expectedBudgetTotal),
      by_plan: byPlan,
    },
    reconciliation: {
      subscribed_without_running_count: Math.max(
        serviceActiveUsers.size - runningContainerUsers.size,
        0,
      ),
      subscribed_without_running_sample_tg_ids: subscribedWithoutRunning,
      running_without_subscribed_count: Math.max(
        runningContainerUsers.size - serviceActiveUsers.size,
        0,
      ),
      running_without_subscribed_sample_tg_ids: runningWithoutSubscribed,
    },
    suggested_checks: [
      "Track webhook-to-period lag: checkout.session.completed -> invoice.paid -> subscription_periods upsert delay",
      "Track runtime readiness lag: invoice.paid timestamp -> container running timestamp",
      "Track plan-budget drift per user: expected credits/100 vs users.litellm_budget_usd",
      "Track Stripe active subscriptions vs service_active_subscription_users delta over time",
    ],
  };
};
