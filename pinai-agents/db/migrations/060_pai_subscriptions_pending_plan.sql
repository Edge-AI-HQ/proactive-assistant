-- pai_subscriptions: add pending_plan_code for "scheduled-for-next-cycle"
-- plan switches. Users switching plan mid-period don't get the new plan
-- (or its budget) immediately — the new plan kicks in at the next renewal
-- (invoice.paid). Until then plan_code stays on the current paid plan and
-- LiteLLM max_budget stays at the current plan's cap. Add credits is the
-- escape valve when the current cap is exhausted.
--
-- pending_plan_code IS NULL means "no scheduled change". When invoice.paid
-- fires, the webhook reads pending_plan_code (if set), promotes it to
-- plan_code, clears the pending column, and resets the LiteLLM budget to
-- the new plan's cap.
--
-- Same plan as plan_code is meaningless (would be a no-op promotion at
-- next renewal). No CHECK constraint here — that's enforced by
-- repository code on write to keep the constraint out of the hot path.

BEGIN;

ALTER TABLE pai_subscriptions
  ADD COLUMN IF NOT EXISTS pending_plan_code TEXT NULL
    REFERENCES pai_billing_plans(plan_code);

COMMENT ON COLUMN pai_subscriptions.pending_plan_code IS
  'Plan to switch to at next invoice.paid. NULL = no scheduled change. '
  'Set by /api/payment/create-checkout on switch; consumed by '
  'webhook _handle_invoice_paid which promotes it to plan_code and '
  'clears this column.';

COMMIT;
