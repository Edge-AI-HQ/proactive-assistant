-- Add reset_spend_on_apply column to subscription_periods table
-- This field controls whether LiteLLM spend should be reset when applying budget for the period
-- true = reset spend (normal new billing cycle)
-- false = preserve spend (upgrade within same billing cycle)
-- null = default to true for backward compatibility

ALTER TABLE subscription_periods
ADD COLUMN IF NOT EXISTS reset_spend_on_apply BOOLEAN DEFAULT TRUE;

COMMENT ON COLUMN subscription_periods.reset_spend_on_apply IS 'Whether to reset LiteLLM spend when applying budget. false for upgrades (preserve spend), true for new cycles (reset spend)';
