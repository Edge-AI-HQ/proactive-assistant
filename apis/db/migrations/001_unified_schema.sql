-- PIN AI unified schema (core + billing)
-- Target: Supabase Postgres (public schema)

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Core identity
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL CHECK (telegram_user_id > 0),
  telegram_username TEXT,
  litellm_user_id TEXT,
  litellm_user_alias TEXT,
  gateway_token TEXT UNIQUE NOT NULL,
  assistant_bot_token TEXT,
  assistant_bot_username TEXT,
  assistant_webhook_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Assistant control plane (no container state duplication)
-- Supports two creation modes:
--   1. Quick Start: assistant_bot_id/token/username = NULL (user chats through guide bot)
--   2. Advanced: assistant_bot_id/token/username = user's own bot (user can chat directly with own bot)
CREATE TABLE IF NOT EXISTS assistants (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_bot_id BIGINT,
  assistant_bot_token TEXT,
  assistant_bot_username TEXT,
  litellm_user_id TEXT,
  litellm_key_alias TEXT,
  litellm_virtual_key_encrypted TEXT,
  litellm_key_last4 TEXT,
  litellm_spend_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  litellm_budget_usd NUMERIC(18, 6),
  litellm_budget_duration TEXT,
  litellm_rpm_limit INTEGER,
  litellm_tpm_limit INTEGER,
  litellm_last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Allow same user to only bind one bot (but multiple users can have NULL for Quick Start)
  CONSTRAINT assistants_owner_bot_unique UNIQUE NULLS NOT DISTINCT (owner_user_id, assistant_bot_id)
);

-- Indexes for bot lookups (only for non-NULL values)
CREATE INDEX IF NOT EXISTS idx_assistants_bot_id ON assistants(assistant_bot_id) WHERE assistant_bot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assistants_bot_token ON assistants(assistant_bot_token) WHERE assistant_bot_token IS NOT NULL;

-- Unified runtime state for both user and assistant containers/machines
CREATE TABLE IF NOT EXISTS runtime_instances (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'assistant')),
  runtime_provider TEXT NOT NULL CHECK (runtime_provider IN ('docker', 'fly')),
  container_name TEXT NOT NULL,
  runtime_ref TEXT,
  host_port BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'running', 'stopped', 'error', 'idle', 'missing')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope = 'user' AND assistant_id IS NULL)
    OR
    (scope = 'assistant' AND assistant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_user_scope_unique
  ON runtime_instances(owner_user_id)
  WHERE scope = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_assistant_scope_unique
  ON runtime_instances(assistant_id)
  WHERE assistant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_container_name_unique
  ON runtime_instances(container_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_runtime_ref_unique
  ON runtime_instances(runtime_ref)
  WHERE runtime_ref IS NOT NULL AND runtime_ref <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_host_port_unique
  ON runtime_instances(host_port);

-- Sessions and admin
-- Gateway sessions: 用户访问助理 gateway 的认证会话
CREATE TABLE IF NOT EXISTS gateway_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE CASCADE,
  session_token TEXT UNIQUE NOT NULL,
  telegram_username_snapshot TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateway_sessions_user_id ON gateway_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_gateway_sessions_assistant_id ON gateway_sessions(assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gateway_sessions_expires_at ON gateway_sessions(expires_at);

COMMENT ON TABLE gateway_sessions IS '用户访问助理 gateway 的认证会话';
COMMENT ON COLUMN gateway_sessions.assistant_id IS '关联的助理 ID；NULL=用户级 session（可访问所有助理），非空=助理级 session（只能访问该助理）';

-- Payment sessions: 支付流程的一次性 token
CREATE TABLE IF NOT EXISTS payment_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE SET NULL,
  session_token TEXT UNIQUE NOT NULL,
  plan_code TEXT,
  telegram_username_snapshot TEXT,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_user_id ON payment_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_assistant_id ON payment_sessions(assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_sessions_expires_at ON payment_sessions(expires_at);

COMMENT ON TABLE payment_sessions IS '支付流程的一次性 token';
COMMENT ON COLUMN payment_sessions.assistant_id IS '关联的助理 ID（可选）；未来支持为特定助理购买订阅';

CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  session_token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_plans (
  plan_code TEXT PRIMARY KEY CHECK (plan_code IN ('basic', 'pro', 'max')),
  display_name TEXT NOT NULL,
  stripe_price_id TEXT UNIQUE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  price_cents_monthly INTEGER NOT NULL CHECK (price_cents_monthly >= 0),
  daily_refresh_credits INTEGER NOT NULL CHECK (daily_refresh_credits >= 0),
  monthly_refresh_credits INTEGER NOT NULL CHECK (monthly_refresh_credits >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 订阅周期表：每个计费周期一行，用于可追溯与幂等
-- 当前生效周期 = period_start <= now() < period_end
CREATE TABLE IF NOT EXISTS subscription_periods (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE CASCADE,
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

-- 按助理查询订阅（未来支持助理级订阅）
CREATE INDEX IF NOT EXISTS idx_subscription_periods_assistant_id
  ON subscription_periods (assistant_id)
  WHERE assistant_id IS NOT NULL;

COMMENT ON TABLE subscription_periods IS 'Stripe 订阅计费周期；当前生效 = period_start <= now() < period_end；LiteLLM 重置由定时任务在 period_start 后执行';
COMMENT ON COLUMN subscription_periods.stripe_customer_id IS 'Stripe Customer ID，用于从 invoice/webhook 按 customer 解析 telegram_user_id';
COMMENT ON COLUMN subscription_periods.stripe_invoice_id IS 'Stripe Invoice ID，用于幂等与追溯';
COMMENT ON COLUMN subscription_periods.budget_applied_at IS 'NULL=未应用；非空=已对该周期执行 LiteLLM reset spend + set budget';
COMMENT ON COLUMN subscription_periods.assistant_id IS '关联的助理 ID（可选）；支持未来每个助理独立订阅；当前为 NULL 表示用户级订阅';

CREATE TABLE IF NOT EXISTS user_credit_wallets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL REFERENCES billing_plans(plan_code),
  daily_credits_remaining INTEGER NOT NULL DEFAULT 0 CHECK (daily_credits_remaining >= 0),
  monthly_credits_remaining INTEGER NOT NULL DEFAULT 0 CHECK (monthly_credits_remaining >= 0),
  next_daily_refresh_at TIMESTAMPTZ NOT NULL,
  next_monthly_refresh_at TIMESTAMPTZ NOT NULL,
  last_litellm_spend_cents BIGINT NOT NULL DEFAULT 0 CHECK (last_litellm_spend_cents >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'daily_refresh',
      'monthly_refresh',
      'usage_debit',
      'plan_change',
      'manual_adjust',
      'wallet_init'
    )
  ),
  delta_daily_credits INTEGER NOT NULL,
  delta_monthly_credits INTEGER NOT NULL,
  daily_credits_after INTEGER NOT NULL CHECK (daily_credits_after >= 0),
  monthly_credits_after INTEGER NOT NULL CHECK (monthly_credits_after >= 0),
  idempotency_key TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE SET NULL,
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  processing_status TEXT NOT NULL DEFAULT 'processing' CHECK (processing_status IN ('processing', 'processed', 'failed')),
  error_message TEXT,
  raw_data JSONB,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_assistant_id
  ON payment_events (assistant_id)
  WHERE assistant_id IS NOT NULL;

COMMENT ON COLUMN payment_events.assistant_id IS '关联的助理 ID（可选）；用于追踪事件属于哪个助理的订阅';

-- User pending actions: 用于存储用户待处理的操作（支持集群部署）
CREATE TABLE IF NOT EXISTS user_pending_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('token_input')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, action_type)
);

CREATE INDEX IF NOT EXISTS idx_user_pending_actions_user_id ON user_pending_actions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_pending_actions_expires_at ON user_pending_actions(expires_at);

COMMENT ON TABLE user_pending_actions IS '用户待处理操作状态（如等待输入 bot token）';

-- VNC 访问令牌表：用于生成临时访问链接
CREATE TABLE IF NOT EXISTS vnc_access_tokens (
  id SERIAL PRIMARY KEY,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  used_from_ip VARCHAR(45)
);

CREATE INDEX IF NOT EXISTS idx_vnc_access_tokens_assistant_id ON vnc_access_tokens(assistant_id);
CREATE INDEX IF NOT EXISTS idx_vnc_access_tokens_token ON vnc_access_tokens(token);
CREATE INDEX IF NOT EXISTS idx_vnc_access_tokens_expires_at ON vnc_access_tokens(expires_at);

COMMENT ON TABLE vnc_access_tokens IS 'VNC 远程桌面访问令牌，用于生成临时访问链接（15分钟有效期）';

-- 自动清理过期的 VNC 访问令牌和待处理操作
CREATE OR REPLACE FUNCTION cleanup_expired_vnc_tokens()
RETURNS void AS $$
BEGIN
  DELETE FROM vnc_access_tokens WHERE expires_at < NOW() - INTERVAL '24 hours';
  DELETE FROM user_pending_actions WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_vnc_tokens IS '清理过期的 VNC 访问令牌（保留24小时）和待处理操作';

INSERT INTO billing_plans (
  plan_code,
  display_name,
  stripe_price_id,
  currency,
  price_cents_monthly,
  daily_refresh_credits,
  monthly_refresh_credits,
  sort_order,
  is_active
) VALUES
  ('basic', 'Basic', 'price_1T50rb2K5fzHJAlc2maOE5fP', 'usd', 3900, 0, 3200, 10, TRUE),
  ('pro', 'Pro', 'price_1T50rc2K5fzHJAlcTYU5PxtX', 'usd', 9900, 0, 12800, 20, TRUE),
  ('max', 'Max', 'price_1T50rd2K5fzHJAlc4WmBNvPy', 'usd', 19900, 0, 28800, 30, TRUE)
ON CONFLICT (plan_code)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  currency = EXCLUDED.currency,
  price_cents_monthly = EXCLUDED.price_cents_monthly,
  daily_refresh_credits = EXCLUDED.daily_refresh_credits,
  monthly_refresh_credits = EXCLUDED.monthly_refresh_credits,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

COMMENT ON COLUMN billing_plans.daily_refresh_credits IS 'Deprecated - use monthly_refresh_credits only';
COMMENT ON COLUMN billing_plans.monthly_refresh_credits IS 'Total credits allocated per month (1 credit ≈ $0.01 in API costs)';

-- Triggers
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_assistants_updated_at ON assistants;
CREATE TRIGGER update_assistants_updated_at
  BEFORE UPDATE ON assistants
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_runtime_instances_updated_at ON runtime_instances;
CREATE TRIGGER update_runtime_instances_updated_at
  BEFORE UPDATE ON runtime_instances
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();


DROP TRIGGER IF EXISTS update_billing_plans_updated_at ON billing_plans;
CREATE TRIGGER update_billing_plans_updated_at
  BEFORE UPDATE ON billing_plans
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_credit_wallets_updated_at ON user_credit_wallets;
CREATE TRIGGER update_user_credit_wallets_updated_at
  BEFORE UPDATE ON user_credit_wallets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_assistant_bot_token_unique
  ON users (assistant_bot_token)
  WHERE assistant_bot_token IS NOT NULL AND assistant_bot_token <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_assistant_bot_username_unique
  ON users (assistant_bot_username)
  WHERE assistant_bot_username IS NOT NULL AND assistant_bot_username <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_litellm_user_id_unique
  ON users (litellm_user_id)
  WHERE litellm_user_id IS NOT NULL AND litellm_user_id <> '';

CREATE INDEX IF NOT EXISTS idx_users_last_active_at ON users(last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistants_owner_created ON assistants(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistants_litellm_key_alias ON assistants(litellm_key_alias);
CREATE INDEX IF NOT EXISTS idx_assistants_litellm_user_id ON assistants(litellm_user_id);
CREATE INDEX IF NOT EXISTS idx_runtime_instances_owner_scope ON runtime_instances(owner_user_id, scope);
CREATE INDEX IF NOT EXISTS idx_runtime_instances_status ON runtime_instances(status);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_billing_plans_active_order ON billing_plans(is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_user_credit_wallets_next_daily ON user_credit_wallets(next_daily_refresh_at);
CREATE INDEX IF NOT EXISTS idx_user_credit_wallets_next_monthly ON user_credit_wallets(next_monthly_refresh_at);
CREATE INDEX IF NOT EXISTS idx_user_credit_wallets_plan_code ON user_credit_wallets(plan_code);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created ON credit_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_event_type_created ON credit_ledger(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_source_created ON credit_ledger(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_user_created ON payment_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_type_created ON payment_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_processing_status ON payment_events(processing_status);

-- RLS + service-role policies
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vnc_access_tokens ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users',
    'assistants',
    'runtime_instances',
    'gateway_sessions',
    'payment_sessions',
    'admin_users',
    'admin_sessions',
    'billing_plans',
    'subscription_periods',
    'user_credit_wallets',
    'credit_ledger',
    'payment_events',
    'user_pending_actions',
    'vnc_access_tokens'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
        AND policyname = 'service_role_all_' || t
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')',
        'service_role_all_' || t,
        t
      );
    END IF;
  END LOOP;
END $$;
