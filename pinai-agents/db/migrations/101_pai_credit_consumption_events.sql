-- Phase 2 扣费审计(append-only;UNIQUE 是跨域重复扣的护栏)。
-- 设计 SSOT: docs/plans/2026-06-15-billing-plan-change-credits.mdx Phase 2。
-- 实施: docs/plans/2026-06-16-billing-credits-topup-implementation.mdx Task 1。
--
-- 对账关窗时一行一笔扣减:allowance 桶记一行,每个被 FIFO 扣的 grant 记一行,
-- 过期作废记一行。UNIQUE(period, grant, bucket) 保证 webhook/对账重放幂等。

CREATE TABLE pai_credit_consumption_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  budget_period_id UUID NOT NULL REFERENCES pai_budget_periods(id) ON DELETE CASCADE,
  grant_id         UUID REFERENCES pai_credit_grants(id),
  bucket           TEXT NOT NULL CHECK (bucket IN ('allowance', 'grant', 'expiry')),
  cents            INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 重放幂等护栏:同一窗口、同一 grant(allowance 桶用全零 uuid 占位)、同一 bucket
-- 只允许一行。对账/webhook 重跑时 ON CONFLICT DO NOTHING。
CREATE UNIQUE INDEX uq_consumption_period_grant_bucket
  ON pai_credit_consumption_events
  (budget_period_id, COALESCE(grant_id, '00000000-0000-0000-0000-000000000000'::uuid), bucket);

ALTER TABLE pai_credit_consumption_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_credit_consumption_events_user_scope ON pai_credit_consumption_events
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_credit_consumption_events_service_role ON pai_credit_consumption_events
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
