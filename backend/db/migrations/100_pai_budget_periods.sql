-- Phase 2 每用户额度窗口(一行 open,历史保留)。
-- 设计 SSOT: docs/plans/2026-06-15-billing-plan-change-credits.mdx Phase 2。
-- 实施: docs/plans/2026-06-16-billing-credits-topup-implementation.mdx Task 1。
--
-- 一个 DB 自管窗口(免费 + 付费统一)驱动对账。invoice.paid 不再直接 reset
-- LiteLLM,只把窗口标到期 → 免费用户(没有 invoice.paid)也有可靠对账点。
-- allowance 先扣、溢出吃 credits 的账务重建,由对账 scheduler 在关窗时做。

CREATE TABLE pai_budget_periods (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supabase_user_id         UUID NOT NULL,
  plan_code                TEXT NOT NULL REFERENCES pai_billing_plans(plan_code),
  allowance_cents          INTEGER NOT NULL,
  allowance_consumed_cents INTEGER NOT NULL DEFAULT 0,
  period_start             TIMESTAMPTZ NOT NULL,
  period_end               TIMESTAMPTZ NOT NULL,  -- 付费: Stripe current_period_end;免费: start+30d
  state                    TEXT NOT NULL DEFAULT 'open'
                           CHECK (state IN ('open', 'reconciling', 'reconciled')),
  opening_litellm_spend    NUMERIC(12, 6) NOT NULL DEFAULT 0,
  closing_litellm_spend    NUMERIC(12, 6),
  last_seen_reset_at       TIMESTAMPTZ,           -- LiteLLM budget_reset_at 锚(自动重置检测)
  reset_applied            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 每用户最多一个未关闭窗口(open 或 reconciling)。
CREATE UNIQUE INDEX uq_budget_periods_one_open
  ON pai_budget_periods (user_id)
  WHERE state IN ('open', 'reconciling');

-- 对账认领:扫 period_end<=NOW() 的 open 窗口。
CREATE INDEX idx_budget_periods_due
  ON pai_budget_periods (period_end)
  WHERE state = 'open';

ALTER TABLE pai_budget_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_budget_periods_user_scope ON pai_budget_periods
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_budget_periods_service_role ON pai_budget_periods
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

-- Backfill: 每个现有用户开一行 open 窗口,plan 取当前订阅(缺省 free)。
-- period_end / opening_litellm_spend 是近似值(NOW+30d / 0);首次对账时
-- 安全网会按 LiteLLM 实际 budget_reset_at 自愈(只多扣不漏扣)。
INSERT INTO pai_budget_periods (
  user_id, supabase_user_id, plan_code, allowance_cents,
  period_start, period_end, state, opening_litellm_spend
)
SELECT
  u.id,
  u.supabase_user_id,
  COALESCE(s.plan_code, 'free'),
  COALESCE(p.monthly_refresh_credits, 0),
  NOW(),
  NOW() + INTERVAL '30 days',
  'open',
  0
FROM users u
LEFT JOIN pai_subscriptions s ON s.user_id = u.id
LEFT JOIN pai_billing_plans p ON p.plan_code = COALESCE(s.plan_code, 'free')
WHERE u.supabase_user_id IS NOT NULL;
