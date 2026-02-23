import type { LiteLLMUsageOverviewRecord } from '../../../types.js';
import { pool, withSchema } from './core.js';

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
      WHERE assistants.litellm_virtual_key_encrypted IS NOT NULL
        AND assistants.litellm_virtual_key_encrypted != ''
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
