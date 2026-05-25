-- Repoint pai_billing_plans to the new active Stripe prices (the old
-- price_1T50r... ones were $4.99/$9.99/$19.99 placeholders, archived
-- 2026-05-24). Add trial_period_days so checkout-session creation can
-- read it from DB instead of hardcoding 7.
--
-- price_cents_monthly is already 3900/9900/19900 in 027 — not touched.
-- Stripe products are not touched (Basic/Pro/Max products reused).

BEGIN;

ALTER TABLE pai_billing_plans
  ADD COLUMN IF NOT EXISTS trial_period_days INTEGER NOT NULL DEFAULT 7
  CHECK (trial_period_days >= 0);

UPDATE pai_billing_plans
   SET stripe_price_id = 'price_1TasPf2K5fzHJAlc5qrONu5B',
       updated_at      = NOW()
 WHERE plan_code = 'basic';

UPDATE pai_billing_plans
   SET stripe_price_id = 'price_1TasPf2K5fzHJAlcPe9rKyvq',
       updated_at      = NOW()
 WHERE plan_code = 'pro';

UPDATE pai_billing_plans
   SET stripe_price_id = 'price_1TasPf2K5fzHJAlc1pVaiOKt',
       updated_at      = NOW()
 WHERE plan_code = 'max';

COMMIT;
