import { lookupUserBySupabaseId, resolveOrCreateUser } from "./userRegistry.js";
import type { PaymentStore } from "./paymentStore.js";
import {
  firstRow,
  toIsoOrNull,
  type CurrentSubscriptionView,
  type Queryable,
  type SubscriptionInfoByStripe,
  type SubscriptionPeriod,
} from "./paymentStoreCore.js";

export interface EndedSubscriptionUser {
  supabase_user_id: string;
  display_name: string | null;
}

const resolveValidAssistantId = async (
  pool: Queryable,
  assistantId: number | null | undefined,
  source: string,
): Promise<number | null> => {
  if (
    typeof assistantId !== "number" ||
    !Number.isFinite(assistantId) ||
    assistantId <= 0
  ) {
    return null;
  }

  const normalizedId = Math.trunc(assistantId);
  const existsResult = await pool.query(
    `
      SELECT 1
      FROM assistants
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedId],
  );
  if ((existsResult.rowCount ?? 0) > 0) {
    return normalizedId;
  }

  console.warn("[payment] ignoring unknown assistant_id", {
    source,
    assistantId: normalizedId,
  });
  return null;
};

export const createSubscriptionPeriodStore = (
  pool: Queryable,
): Pick<
  PaymentStore,
  | "upsertSubscriptionPeriod"
  | "getPeriodsToApplyBudget"
  | "markPeriodBudgetApplied"
  | "getCurrentPeriodBySupabaseId"
  | "getSubscriptionInfoByStripeSubscriptionId"
  | "getSubscriptionInfoByStripeCustomerId"
  | "getUsersWithEndedSubscriptionNoCurrentPeriod"
  | "updateSubscriptionCancelFlag"
  | "truncateSubscriptionPeriodsAt"
  | "claimSubscriptionEventOrder"
  | "claimStripeEvent"
  | "markStripeEventProcessed"
  | "markStripeEventFailed"
  | "ensureUser"
> => {
  return {
    async upsertSubscriptionPeriod(data) {
      const user = await lookupUserBySupabaseId(pool, data.supabase_user_id);
      if (!user) {
        throw new Error(
          `Cannot upsert subscription period: user not found for supabase_user_id ${data.supabase_user_id}`,
        );
      }

      const periodStartIso = toIsoOrNull(data.period_start);
      const periodEndIso = toIsoOrNull(data.period_end);
      if (!periodStartIso || !periodEndIso) {
        throw new Error(
          "upsertSubscriptionPeriod requires valid period_start and period_end",
        );
      }
      const assistantId = await resolveValidAssistantId(
        pool,
        data.assistant_id ?? null,
        "upsertSubscriptionPeriod",
      );

      await pool.query(
        `
          INSERT INTO subscription_periods (
            user_id,
            stripe_subscription_id,
            stripe_customer_id,
            stripe_invoice_id,
            period_start,
            period_end,
            plan_id,
            status,
            cancel_at_period_end,
            assistant_id,
            reset_spend_on_apply
          ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, $10, $11)
          ON CONFLICT (stripe_subscription_id, period_start)
          DO UPDATE SET
            stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscription_periods.stripe_customer_id),
            stripe_invoice_id = COALESCE(EXCLUDED.stripe_invoice_id, subscription_periods.stripe_invoice_id),
            period_end = EXCLUDED.period_end,
            plan_id = EXCLUDED.plan_id,
            status = EXCLUDED.status,
            cancel_at_period_end = EXCLUDED.cancel_at_period_end,
            assistant_id = COALESCE(EXCLUDED.assistant_id, subscription_periods.assistant_id),
            reset_spend_on_apply = COALESCE(EXCLUDED.reset_spend_on_apply, subscription_periods.reset_spend_on_apply),
            updated_at = NOW()
        `,
        [
          user.id,
          data.stripe_subscription_id,
          data.stripe_customer_id ?? null,
          data.stripe_invoice_id ?? null,
          periodStartIso,
          periodEndIso,
          data.plan_id,
          data.status ?? "active",
          data.cancel_at_period_end === true,
          assistantId,
          data.reset_spend_on_apply ?? true, // Default true for backward compatibility
        ],
      );
    },

    async getPeriodsToApplyBudget(now) {
      const nowIso =
        now instanceof Date && Number.isFinite(now.getTime())
          ? now.toISOString()
          : new Date().toISOString();
      const result = await pool.query<SubscriptionPeriod>(
        `
          SELECT
            sp.id,
            sp.user_id,
            users.supabase_user_id::text AS supabase_user_id,
            users.display_name,
            sp.stripe_subscription_id,
            sp.stripe_customer_id,
            sp.stripe_invoice_id,
            sp.period_start::text,
            sp.period_end::text,
            sp.plan_id,
            sp.status,
            sp.cancel_at_period_end,
            sp.budget_applied_at::text,
            sp.reset_spend_on_apply,
            sp.created_at::text,
            sp.updated_at::text
          FROM subscription_periods sp
          JOIN users ON users.id = sp.user_id
          WHERE sp.period_start <= $1::timestamptz
            AND sp.period_end > $1::timestamptz
            AND sp.budget_applied_at IS NULL
          FOR UPDATE OF sp SKIP LOCKED
        `,
        [nowIso],
      );
      return result.rows;
    },

    async getCurrentPeriodBySupabaseId(supabase_user_id, now) {
      const nowIso =
        now instanceof Date && Number.isFinite(now.getTime())
          ? now.toISOString()
          : new Date().toISOString();
      const result = await pool.query<
        CurrentSubscriptionView & {
          stripe_customer_id: string | null;
          period_start: string;
          period_end: string;
        }
      >(
        `
          SELECT
            users.supabase_user_id::text AS supabase_user_id,
            users.display_name,
            sp.stripe_customer_id,
            sp.stripe_subscription_id,
            sp.plan_id,
            sp.status,
            sp.cancel_at_period_end,
            sp.period_start::text AS current_period_start,
            sp.period_end::text AS current_period_end
          FROM subscription_periods sp
          JOIN users ON users.id = sp.user_id
          WHERE users.supabase_user_id = $1::bigint
            AND sp.period_start <= $2::timestamptz
            AND sp.period_end > $2::timestamptz
          ORDER BY sp.period_start DESC, sp.updated_at DESC, sp.period_end DESC
          LIMIT 1
        `,
        [supabase_user_id, nowIso],
      );
      const row = firstRow(result.rows);
      if (!row) return null;
      return {
        supabase_user_id: row.supabase_user_id,
        display_name: row.display_name,
        stripe_customer_id: row.stripe_customer_id,
        stripe_subscription_id: row.stripe_subscription_id,
        plan_id: row.plan_id,
        status: row.status,
        cancel_at_period_end: row.cancel_at_period_end,
        current_period_start: row.current_period_start,
        current_period_end: row.current_period_end,
      };
    },

    async getSubscriptionInfoByStripeSubscriptionId(stripe_subscription_id) {
      const result = await pool.query<SubscriptionInfoByStripe>(
        `
          SELECT
            users.supabase_user_id::text AS supabase_user_id,
            users.display_name,
            sp.stripe_subscription_id,
            sp.plan_id
          FROM subscription_periods sp
          JOIN users ON users.id = sp.user_id
          WHERE sp.stripe_subscription_id = $1
          ORDER BY sp.period_end DESC
          LIMIT 1
        `,
        [stripe_subscription_id],
      );
      return firstRow(result.rows);
    },

    async getSubscriptionInfoByStripeCustomerId(stripe_customer_id) {
      const result = await pool.query<SubscriptionInfoByStripe>(
        `
          SELECT
            users.supabase_user_id::text AS supabase_user_id,
            users.display_name,
            sp.stripe_subscription_id,
            sp.plan_id
          FROM subscription_periods sp
          JOIN users ON users.id = sp.user_id
          WHERE sp.stripe_customer_id = $1
          ORDER BY sp.period_end DESC
          LIMIT 1
        `,
        [stripe_customer_id],
      );
      return firstRow(result.rows);
    },

    async getUsersWithEndedSubscriptionNoCurrentPeriod(now) {
      const nowIso =
        now instanceof Date && Number.isFinite(now.getTime())
          ? now.toISOString()
          : new Date().toISOString();
      const result = await pool.query<EndedSubscriptionUser>(
        `
          SELECT DISTINCT
            u.supabase_user_id::text AS supabase_user_id,
            u.display_name
          FROM users u
          WHERE EXISTS (
            SELECT 1 FROM subscription_periods sp
            WHERE sp.user_id = u.id AND sp.period_end < $1::timestamptz
          )
          AND NOT EXISTS (
            SELECT 1 FROM subscription_periods sp
            WHERE sp.user_id = u.id
              AND sp.period_start <= $1::timestamptz
              AND sp.period_end > $1::timestamptz
          )
        `,
        [nowIso],
      );
      return result.rows;
    },

    async markPeriodBudgetApplied(periodId) {
      const result = await pool.query(
        `
          UPDATE subscription_periods
          SET budget_applied_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND budget_applied_at IS NULL
        `,
        [periodId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async updateSubscriptionCancelFlag(
      stripe_subscription_id,
      cancel_at_period_end,
      status,
    ) {
      const updates = ["cancel_at_period_end = $2", "updated_at = NOW()"];
      const params: any[] = [stripe_subscription_id, cancel_at_period_end];

      if (status) {
        updates.push("status = $3");
        params.push(status);
      }

      const result = await pool.query(
        `
          UPDATE subscription_periods
          SET ${updates.join(", ")}
          WHERE stripe_subscription_id = $1
        `,
        params,
      );
      return (result.rowCount ?? 0) > 0;
    },

    async truncateSubscriptionPeriodsAt(stripe_subscription_id, ended_at, status) {
      const endedAtIso = toIsoOrNull(ended_at);
      if (!endedAtIso) return false;

      const updates = [
        "period_end = GREATEST(period_start, LEAST(period_end, $2::timestamptz))",
        "cancel_at_period_end = false",
        "updated_at = NOW()",
      ];
      const params: unknown[] = [stripe_subscription_id, endedAtIso];

      if (status) {
        updates.push("status = $3");
        params.push(status);
      }

      const result = await pool.query(
        `
          UPDATE subscription_periods
          SET ${updates.join(", ")}
          WHERE stripe_subscription_id = $1
            AND period_start < $2::timestamptz
            AND period_end > $2::timestamptz
        `,
        params,
      );
      return (result.rowCount ?? 0) > 0;
    },

    async ensureUser(supabase_user_id, display_name) {
      return resolveOrCreateUser(pool, supabase_user_id, display_name);
    },

    async claimSubscriptionEventOrder(data) {
      const stripeSubscriptionId = data.stripe_subscription_id?.trim();
      const eventId = data.event_id?.trim();
      const eventCreated = Number.isFinite(data.event_created)
        ? Math.max(0, Math.trunc(data.event_created))
        : 0;
      if (!stripeSubscriptionId || !eventId || eventCreated <= 0) {
        return "process";
      }

      const result = await pool.query(
        `
          INSERT INTO stripe_subscription_event_watermarks (
            stripe_subscription_id,
            last_event_created,
            last_event_id
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (stripe_subscription_id)
          DO UPDATE SET
            last_event_created = EXCLUDED.last_event_created,
            last_event_id = EXCLUDED.last_event_id,
            updated_at = NOW()
          WHERE stripe_subscription_event_watermarks.last_event_created < EXCLUDED.last_event_created
             OR (
               stripe_subscription_event_watermarks.last_event_created = EXCLUDED.last_event_created
               AND stripe_subscription_event_watermarks.last_event_id < EXCLUDED.last_event_id
             )
          RETURNING stripe_subscription_id
        `,
        [stripeSubscriptionId, eventCreated, eventId],
      );

      return (result.rowCount ?? 0) > 0 ? "process" : "skip";
    },

    async claimStripeEvent(data) {
      const user = data.supabase_user_id
        ? await resolveOrCreateUser(pool, data.supabase_user_id, undefined)
        : null;
      const assistantId = await resolveValidAssistantId(
        pool,
        data.assistant_id ?? null,
        "claimStripeEvent",
      );

      const insertResult = await pool.query<{ id: number }>(
        `
          INSERT INTO payment_events (
            user_id,
            assistant_id,
            stripe_event_id,
            event_type,
            amount,
            currency,
            status,
            processing_status,
            error_message,
            raw_data
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, 'processing', NULL, $8::jsonb
          )
          ON CONFLICT (stripe_event_id) DO NOTHING
          RETURNING id
        `,
        [
          user?.id ?? null,
          assistantId,
          data.stripe_event_id,
          data.event_type,
          data.amount ?? null,
          data.currency ?? null,
          data.status ?? null,
          JSON.stringify(data.raw_data ?? null),
        ],
      );

      if ((insertResult.rowCount ?? 0) > 0) {
        return "process";
      }

      const reclaim = await pool.query<{ id: number }>(
        `
          UPDATE payment_events
          SET
            user_id = COALESCE($2, user_id),
            assistant_id = COALESCE($3, assistant_id),
            event_type = $4,
            amount = $5,
            currency = $6,
            status = $7,
            processing_status = 'processing',
            error_message = NULL,
            processed_at = NULL,
            raw_data = $8::jsonb
          WHERE stripe_event_id = $1
            AND processing_status = 'failed'
          RETURNING id
        `,
        [
          data.stripe_event_id,
          user?.id ?? null,
          assistantId,
          data.event_type,
          data.amount ?? null,
          data.currency ?? null,
          data.status ?? null,
          JSON.stringify(data.raw_data ?? null),
        ],
      );

      return (reclaim.rowCount ?? 0) > 0 ? "process" : "skip";
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
        [stripe_event_id],
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
        [stripe_event_id, errorMessage],
      );
    },
  };
};
