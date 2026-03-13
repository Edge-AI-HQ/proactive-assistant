import type { LiteLLMUsageOverviewRecord } from '../../../types.js';
import { pool, withSchema } from './core.js';

export interface CreditWalletRecord {
  monthly_credits_remaining: number;
  plan_code: string;
}

export const getCreditWalletByUserId = async (userId: number): Promise<CreditWalletRecord | null> => {
  await withSchema();
  const result = await pool.query<CreditWalletRecord>(
    `SELECT monthly_credits_remaining, plan_code FROM user_credit_wallets WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
};

export const getPlanMonthlyCredits = async (planCode: string): Promise<number> => {
  await withSchema();
  const result = await pool.query<{ monthly_refresh_credits: number }>(
    `SELECT monthly_refresh_credits FROM billing_plans WHERE plan_code = $1 AND is_active = TRUE LIMIT 1`,
    [planCode],
  );
  return result.rows[0]?.monthly_refresh_credits ?? 0;
};

export const getLiteLLMUsageOverview = async (): Promise<LiteLLMUsageOverviewRecord> => {
  await withSchema();
  const result = await pool.query<LiteLLMUsageOverviewRecord>(
    `
      SELECT
        COUNT(*)::int AS assistants_with_keys,
        COALESCE(
          SUM(
            CASE
              WHEN assistants.litellm_budget_usd IS NOT NULL
               AND assistants.litellm_budget_usd > 0
               AND COALESCE(assistants.litellm_spend_usd, 0) >= assistants.litellm_budget_usd
              THEN 1
              ELSE 0
            END
          ),
          0
        )::int AS assistants_over_budget,
        COALESCE(SUM(COALESCE(assistants.litellm_spend_usd, 0)), 0) AS total_spend_usd
      FROM assistants
      WHERE assistants.litellm_virtual_key IS NOT NULL
        AND assistants.litellm_virtual_key != ''
    `
  );

  return (
    result.rows[0] ?? {
      assistants_with_keys: 0,
      assistants_over_budget: 0,
      total_spend_usd: 0
    }
  );
};
