import { lookupUserByTelegramId, resolveOrCreateUser } from './userRegistry.js';
import type { PaymentStore } from './paymentStore.js';
import {
  firstRow,
  subscriptionSelectSql,
  toIsoOrNull,
  type Queryable,
  type UserSubscription
} from './paymentStoreCore.js';

export const createSubscriptionStore = (
  pool: Queryable
): Pick<
  PaymentStore,
  | 'upsertUserSubscription'
  | 'getSubscriptionByTelegramId'
  | 'getSubscriptionByStripeCustomerId'
  | 'getSubscriptionByStripeSubscriptionId'
  | 'updateSubscriptionStatus'
  | 'claimStripeEvent'
  | 'markStripeEventProcessed'
  | 'markStripeEventFailed'
  | 'getActiveSubscriptions'
> => {
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

    async updateSubscriptionStatus(
      telegram_user_id,
      status,
      period_start,
      period_end,
      cancel_at_period_end,
      stripe_event_created,
      stripe_event_id
    ) {
      const user = await lookupUserByTelegramId(pool, telegram_user_id);
      if (!user) return false;

      const result = await pool.query(
        `
          UPDATE user_subscriptions
          SET
            status = $2,
            current_period_start = $3,
            current_period_end = $4,
            cancel_at_period_end = COALESCE($5, cancel_at_period_end),
            last_stripe_event_created = CASE WHEN $6::bigint IS NULL THEN last_stripe_event_created ELSE $6::bigint END,
            last_stripe_event_id = CASE WHEN $7::text IS NULL THEN last_stripe_event_id ELSE $7::text END,
            updated_at = NOW()
          WHERE user_id = $1
            AND (
              $6::bigint IS NULL
              OR user_subscriptions.last_stripe_event_created IS NULL
              OR $6::bigint > user_subscriptions.last_stripe_event_created
              OR (
                $6::bigint = user_subscriptions.last_stripe_event_created
                AND COALESCE($7::text, '') > COALESCE(user_subscriptions.last_stripe_event_id, '')
              )
            )
        `,
        [
          user.id,
          status,
          toIsoOrNull(period_start),
          toIsoOrNull(period_end),
          cancel_at_period_end === undefined ? null : cancel_at_period_end,
          Number.isFinite(stripe_event_created) ? Math.trunc(stripe_event_created as number) : null,
          typeof stripe_event_id === 'string' && stripe_event_id.trim() ? stripe_event_id.trim() : null
        ]
      );

      return (result.rowCount ?? 0) > 0;
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
            processed_at = NULL,
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
    }
  };
};
