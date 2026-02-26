-- Simplify credits to monthly-only (remove daily_refresh_credits)
-- Set monthly_refresh_credits to the total amount users should get per month

-- Update existing plans to use monthly-only credits
UPDATE billing_plans SET
  daily_refresh_credits = 0,
  monthly_refresh_credits = CASE plan_code
    WHEN 'basic' THEN 1000  -- $10 plan: 1000 credits/month (~$10 in API costs)
    WHEN 'pro' THEN 2000    -- $20 plan: 2000 credits/month (~$20 in API costs)
    WHEN 'max' THEN 5000    -- $50 plan: 5000 credits/month (~$50 in API costs)
  END,
  updated_at = NOW()
WHERE plan_code IN ('basic', 'pro', 'max');

-- Add comment explaining the credit system
COMMENT ON COLUMN billing_plans.daily_refresh_credits IS 'Deprecated - use monthly_refresh_credits only';
COMMENT ON COLUMN billing_plans.monthly_refresh_credits IS 'Total credits allocated per month (1 credit ≈ $0.01 in API costs)';
