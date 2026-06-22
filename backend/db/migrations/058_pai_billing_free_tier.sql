-- Add Free as a first-class plan (the default state for everyone who
-- never subscribed). Re-shape paid plan budgets to match prices 1:1
-- so each paid tier is "you pay $X, you get $X of LLM budget".
--
-- Budget = monthly_refresh_credits / 100 (100 credits = $1 USD,
-- existing convention).
--
-- Free has no Stripe price (NULL allowed on stripe_price_id);
-- subscribed via SQL backfill below, not via Checkout.

BEGIN;

-- 1) Allow NULL stripe_price_id (Free has none) + add 'free' to enum CHECK
ALTER TABLE pai_billing_plans ALTER COLUMN stripe_price_id DROP NOT NULL;

ALTER TABLE pai_billing_plans DROP CONSTRAINT IF EXISTS pai_billing_plans_plan_code_check;
ALTER TABLE pai_billing_plans ADD CONSTRAINT pai_billing_plans_plan_code_check
  CHECK (plan_code IN ('free', 'basic', 'pro', 'max'));

-- 2) Insert Free plan. No Stripe price, $0 price, $5 monthly budget.
INSERT INTO pai_billing_plans
  (plan_code, display_name, stripe_price_id, currency,
   price_cents_monthly, monthly_refresh_credits, trial_period_days,
   sort_order, is_active, metadata)
VALUES
  ('free', 'Free', NULL, 'usd',
   0, 500, 0,
   5, TRUE, '{}'::jsonb)
ON CONFLICT (plan_code) DO NOTHING;

-- 3) Re-align paid plan budgets so price (cents) == credits (cents-equivalent).
-- Pre-058: basic=3200 ($32), pro=12800 ($128), max=28800 ($288) — under/over
-- the price. Post-058: each tier's budget == its price (1:1, no margin/cap).
UPDATE pai_billing_plans
  SET monthly_refresh_credits = 3900,  -- $39 budget == $39 price
      updated_at = NOW()
  WHERE plan_code = 'basic';
UPDATE pai_billing_plans
  SET monthly_refresh_credits = 9900,  -- $99 budget == $99 price
      updated_at = NOW()
  WHERE plan_code = 'pro';
UPDATE pai_billing_plans
  SET monthly_refresh_credits = 19900, -- $199 budget == $199 price
      updated_at = NOW()
  WHERE plan_code = 'max';

-- 4) Backfill: every existing user who has no pai_subscriptions row gets
-- a Free row so the API surface (getCurrentSubscription, guard checks)
-- can rely on a row existing for every user.
INSERT INTO pai_subscriptions
  (user_id, stripe_customer_id, stripe_subscription_id,
   plan_code, status,
   current_period_start, current_period_end, cancel_at_period_end,
   created_at, updated_at)
SELECT u.id, NULL, NULL,
       'free', 'active',
       NULL, NULL, FALSE,
       NOW(), NOW()
  FROM users u
  WHERE NOT EXISTS (
    SELECT 1 FROM pai_subscriptions s WHERE s.user_id = u.id
  );

COMMIT;
