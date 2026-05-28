-- Disable the 7-day free trial on all paid plans. Going forward, "pay or
-- you don't subscribe" — Stripe checkout creates a subscription that
-- bills immediately, no trialing state for new users.
--
-- Schema kept additive: trial_period_days COLUMN is preserved (still on
-- pai_billing_plans, exposed via plans.py + /api/payment/plans) so legacy
-- trialing users (created before this migration) keep rendering. Existing
-- subscriptions with status='trialing' are not modified here — they ride
-- out naturally, or get cleaned up via scripts/repair_litellm_budget.py.

BEGIN;

-- 1) Set all current plan rows to 0 days of trial.
UPDATE pai_billing_plans
   SET trial_period_days = 0,
       updated_at = NOW()
 WHERE trial_period_days <> 0;

-- 2) Future INSERTs default to 0 (was 7 from migration 057).
ALTER TABLE pai_billing_plans
  ALTER COLUMN trial_period_days SET DEFAULT 0;

COMMIT;
