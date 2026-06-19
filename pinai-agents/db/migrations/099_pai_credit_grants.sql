-- Phase 2 credits 充值台账(append-only,一次充值一行)。
-- 设计 SSOT: docs/plans/2026-06-15-billing-plan-change-credits.mdx Phase 2。
-- 实施: docs/plans/2026-06-16-billing-credits-topup-implementation.mdx Task 1。
--
-- 充值 credits 持久、12 月过期、不退。grant_cents/consumed_cents 以整数分
-- 计(1 credit = $0.01,对齐 monthly_refresh_credits),只在 LiteLLM 边界 ÷100。
-- 经济身份 = stripe_payment_intent_id,作为充值幂等锚(唯一索引兜外层重放)。

CREATE TABLE pai_credit_grants (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supabase_user_id         UUID NOT NULL,
  grant_cents              INTEGER NOT NULL CHECK (grant_cents > 0),
  consumed_cents           INTEGER NOT NULL DEFAULT 0
                           CHECK (consumed_cents >= 0 AND consumed_cents <= grant_cents),
  source                   TEXT NOT NULL DEFAULT 'topup'
                           CHECK (source IN ('topup', 'promo', 'adjustment')),
  stripe_payment_intent_id TEXT,
  stripe_event_id          TEXT,
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL,  -- granted_at + 12 months
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'exhausted', 'expired')),
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 充值幂等:一个 payment_intent 最多一行 topup grant。
CREATE UNIQUE INDEX uq_credit_grants_topup_pi
  ON pai_credit_grants (stripe_payment_intent_id)
  WHERE source = 'topup' AND stripe_payment_intent_id IS NOT NULL;

-- FIFO 最早过期先扣:对账时按 (expires_at, granted_at) 升序遍历 active grants。
CREATE INDEX idx_credit_grants_user_active
  ON pai_credit_grants (user_id, expires_at, granted_at)
  WHERE status = 'active';

ALTER TABLE pai_credit_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_credit_grants_user_scope ON pai_credit_grants
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_credit_grants_service_role ON pai_credit_grants
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
