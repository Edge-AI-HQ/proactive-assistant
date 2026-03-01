-- 订阅周期表：每个计费周期一行，用于可追溯与幂等
-- 当前生效 = period_start <= now() < period_end
-- 新周期开始时由定时任务根据 period_start 应用 LiteLLM budget（重置 spend）

CREATE TABLE IF NOT EXISTS subscription_periods (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_invoice_id TEXT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  plan_id TEXT NOT NULL REFERENCES billing_plans(plan_code),
  status TEXT NOT NULL DEFAULT 'active',
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  budget_applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT subscription_periods_unique_sub_period
    UNIQUE (stripe_subscription_id, period_start)
);

-- 同一张发票只对应一个周期（幂等：重复 invoice.paid 不会重复插入）
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_periods_stripe_invoice_id
  ON subscription_periods (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- 按 stripe_customer_id 解析用户（invoice/webhook）
CREATE INDEX IF NOT EXISTS idx_subscription_periods_stripe_customer_id
  ON subscription_periods (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- 定时任务：查未应用且当前时间已进入的周期
CREATE INDEX IF NOT EXISTS idx_subscription_periods_apply_budget
  ON subscription_periods (period_start, period_end, budget_applied_at)
  WHERE budget_applied_at IS NULL;

-- 按用户 + 时间范围查当前生效周期
CREATE INDEX IF NOT EXISTS idx_subscription_periods_user_period
  ON subscription_periods (user_id, period_start, period_end);

COMMENT ON TABLE subscription_periods IS 'Stripe 订阅计费周期；当前生效 = period_start <= now() < period_end；LiteLLM 重置由定时任务在 period_start 后执行';
COMMENT ON COLUMN subscription_periods.stripe_customer_id IS 'Stripe Customer ID，用于从 invoice/webhook 按 customer 解析 telegram_user_id';
COMMENT ON COLUMN subscription_periods.stripe_invoice_id IS 'Stripe Invoice ID，用于幂等与追溯';
COMMENT ON COLUMN subscription_periods.budget_applied_at IS 'NULL=未应用；非空=已对该周期执行 LiteLLM reset spend + set budget';

DROP TRIGGER IF EXISTS update_subscription_periods_updated_at ON subscription_periods;
CREATE TRIGGER update_subscription_periods_updated_at
  BEFORE UPDATE ON subscription_periods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
