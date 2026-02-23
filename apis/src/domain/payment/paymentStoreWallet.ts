import { lookupUserByTelegramId, normalizeUsername, resolveOrCreateUser } from './userRegistry.js';
import type { PaymentStore } from './paymentStore.js';
import {
  clampNonNegativeInt,
  firstRow,
  isUniqueViolation,
  nextUtcMidnight,
  readPlanByCode,
  readUserIdentityByTelegramId,
  readWalletByUserId,
  withTransaction,
  type Queryable,
  type UserIdentity,
  type UserCreditWallet
} from './paymentStoreCore.js';

export const createWalletStore = (
  pool: Queryable
): Pick<
  PaymentStore,
  | 'getUserIdentityByTelegramId'
  | 'upsertUserLiteLLMIdentity'
  | 'getWalletByUserId'
  | 'upsertWalletPlanContext'
  | 'applyMonthlyCreditsRefresh'
  | 'listUsersDueDailyCreditRefresh'
  | 'refreshDailyCreditsByUserId'
  | 'applyUsageDebitByUserId'
> => {
  return {
    async getUserIdentityByTelegramId(telegram_user_id) {
      return readUserIdentityByTelegramId(pool, telegram_user_id);
    },

    async upsertUserLiteLLMIdentity(data) {
      const user = await resolveOrCreateUser(pool, data.telegram_user_id, data.telegram_username);
      const litellmUserId = data.litellm_user_id.trim();
      const litellmAlias = normalizeUsername(data.litellm_user_alias);
      const spendUsd =
        data.litellm_spend_usd !== undefined && data.litellm_spend_usd !== null
          ? Number.isFinite(data.litellm_spend_usd)
            ? Math.max(0, Number(data.litellm_spend_usd.toFixed(6)))
            : 0
          : null;
      const budgetUsd =
        data.litellm_budget_usd !== undefined && data.litellm_budget_usd !== null
          ? Number.isFinite(data.litellm_budget_usd)
            ? Math.max(0, Number(data.litellm_budget_usd.toFixed(6)))
            : 0
          : null;
      const budgetDuration =
        data.litellm_budget_duration !== undefined
          ? typeof data.litellm_budget_duration === 'string'
            ? data.litellm_budget_duration.trim() || null
            : null
          : null;
      const lastSyncedAt = (() => {
        if (data.litellm_last_synced_at === undefined || data.litellm_last_synced_at === null) return null;
        const parsed = new Date(data.litellm_last_synced_at);
        if (Number.isNaN(parsed.getTime())) return null;
        return parsed.toISOString();
      })();

      const result = await pool.query<UserIdentity>(
        `
          UPDATE users
          SET
            litellm_user_id = $2,
            litellm_user_alias = COALESCE($3, litellm_user_alias),
            litellm_spend_usd = COALESCE($4, litellm_spend_usd),
            litellm_budget_usd = COALESCE($5, litellm_budget_usd),
            litellm_budget_duration = COALESCE($6, litellm_budget_duration),
            litellm_last_synced_at = COALESCE($7::timestamptz, litellm_last_synced_at),
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
        [user.id, litellmUserId, litellmAlias, spendUsd, budgetUsd, budgetDuration, lastSyncedAt]
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
