-- Stripe-account migration cleanup (paired with migration 061).
--
-- The old PIN-AI Stripe account's customer IDs (cus_*) and subscription
-- IDs (sub_*) DO NOT EXIST in the new Edge-AI-HQ account. Any code path
-- that tries to retrieve / modify them via Stripe will 404. So we wipe
-- every user back to the "free" baseline and let them re-subscribe
-- against the new account from scratch.
--
-- Safe in dev / test only — destructive for any real user state. We
-- intentionally accept "everyone effectively starts over" because:
--   (a) Test mode means there are no real charges to refund.
--   (b) Internal testers (liam.yu0301 et al.) are the only ones with
--       data here and they've been informed.
--
-- LiteLLM max_budget is NOT touched here — that's handled by the
-- repair_litellm_budget.py admin script post-migration (sets every
-- user's key to the free $5/30d cap).

BEGIN;

-- 1) Drop the old Stripe customer linkage on every user.
UPDATE users
   SET stripe_customer_id = NULL
 WHERE stripe_customer_id IS NOT NULL;

-- 2) Reset every subscription row back to "free / active / no Stripe".
--    Keep the row (one per user) so getCurrentSubscription always has
--    something to return — matches the Free-tier backfill from 058.
UPDATE pai_subscriptions
   SET stripe_customer_id     = NULL,
       stripe_subscription_id = NULL,
       plan_code              = 'free',
       pending_plan_code      = NULL,
       status                 = 'active',
       current_period_start   = NULL,
       current_period_end     = NULL,
       cancel_at_period_end   = FALSE,
       updated_at             = NOW();

COMMIT;
