import { normalizeUsername, resolveOrCreateUser } from './userRegistry.js';
import type { PaymentStore } from './paymentStore.js';
import { firstRow, readUserIdentityByTelegramId, type Queryable, type UserIdentity } from './paymentStoreCore.js';

export const createIdentityStore = (
  pool: Queryable
): Pick<PaymentStore, 'getUserIdentityByTelegramId' | 'upsertUserLiteLLMIdentity'> => {
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
    }
  };
};
