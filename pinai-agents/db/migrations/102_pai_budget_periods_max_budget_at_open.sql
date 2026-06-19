-- Phase 2 reconcile safety net: store the LiteLLM ceiling (allowance + active
-- credits, in cents) at window open. When the reconcile job detects LiteLLM's
-- own 30d auto-reset raced ahead of us (budget_reset_at jumped past
-- last_seen_reset_at), the post-reset spend reads near 0 and (closing-opening)
-- would under-count. We instead bound the window's max possible draw as
-- max_budget_cents_at_open − opening_spend (conservative: only ever over-charges).
--
-- Nullable: rows backfilled by 100 predate this column and fall back to
-- allowance_cents in the safety-net branch.
-- 实施: docs/plans/2026-06-16-billing-credits-topup-implementation.mdx Task 4。

ALTER TABLE pai_budget_periods
  ADD COLUMN max_budget_cents_at_open INTEGER;
