-- Testing-phase bump of the Free tier LLM budget: 500 credits ($5/30d)
-- starves internal testers within days — per-user LiteLLM keys hit
-- "Budget has been exceeded" and every call 429s until the window
-- resets (observed on dev, 2026-06-11). Raise to 100000 credits
-- ($1000/30d) while we are pre-launch. Revisit before launch.
--
-- Scope note: provisioning reads this row when minting a key
-- (litellm_provisioning._provision_and_persist), so only keys minted
-- after this lands pick up the new ceiling. Existing dev keys were
-- bumped out-of-band via the LiteLLM admin API (/key/update).
UPDATE pai_billing_plans
  SET monthly_refresh_credits = 100000, -- $1000 budget while testing
      updated_at = NOW()
  WHERE plan_code = 'free';
