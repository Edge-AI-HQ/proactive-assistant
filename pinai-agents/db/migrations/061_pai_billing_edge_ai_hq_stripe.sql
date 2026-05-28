-- Switch the billing-plan catalog to the new Edge-AI-HQ Stripe account.
-- The old PIN-AI Stripe account's price IDs (price_1TasPf*) are not valid
-- in the new account, so any checkout against the old IDs would 4xx.
-- This migration re-points the 3 paid plans to the new account's
-- recurring monthly prices.
--
-- Account migration context (2026-05-27):
--   PIN-AI Stripe       (sk_test_51SnABk...)  → retired
--   Edge-AI-HQ Stripe   (sk_test_51TbozRIA...) → active
--
-- Old subscriptions / customers referenced by users.stripe_customer_id
-- and pai_subscriptions.* still point at the dead account and are
-- handled by the follow-up migration 062 (reset to free + clear).
--
-- The "free" plan has NULL stripe_price_id (no Stripe equivalent) so it's
-- not touched.

BEGIN;

UPDATE pai_billing_plans
   SET stripe_price_id = 'price_1Tbr4pIAjVJ0AJd8Ra03XxNN',
       updated_at      = NOW()
 WHERE plan_code = 'basic';

UPDATE pai_billing_plans
   SET stripe_price_id = 'price_1Tbr5ZIAjVJ0AJd83efMgNHL',
       updated_at      = NOW()
 WHERE plan_code = 'pro';

UPDATE pai_billing_plans
   SET stripe_price_id = 'price_1Tbr6jIAjVJ0AJd8cx39ppX7',
       updated_at      = NOW()
 WHERE plan_code = 'max';

COMMIT;
