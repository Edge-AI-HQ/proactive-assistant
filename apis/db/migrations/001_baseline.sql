-- PIN AI baseline schema
-- Consolidated from migrations 001-019 (pre-launch clean slate).
-- Target: Supabase Postgres (public schema)

-- ============================================================
-- Utility functions
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Core identity
-- ============================================================

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE,
  telegram_username TEXT,
  supabase_user_id UUID UNIQUE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  auth_provider TEXT,
  litellm_user_id TEXT,
  litellm_user_alias TEXT,
  litellm_key_alias TEXT,
  litellm_virtual_key TEXT,
  litellm_key_last4 TEXT,
  litellm_spend_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  litellm_budget_usd NUMERIC(18, 6),
  litellm_budget_duration TEXT,
  litellm_rpm_limit INTEGER,
  litellm_tpm_limit INTEGER,
  litellm_last_synced_at TIMESTAMPTZ,
  gateway_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_telegram_user_id_check CHECK (telegram_user_id IS NULL OR telegram_user_id > 0)
);

CREATE UNIQUE INDEX idx_users_litellm_user_id_unique
  ON users (litellm_user_id) WHERE litellm_user_id IS NOT NULL AND litellm_user_id <> '';
CREATE INDEX idx_users_litellm_key_alias
  ON users (litellm_key_alias) WHERE litellm_key_alias IS NOT NULL AND litellm_key_alias <> '';
CREATE INDEX idx_users_last_active_at ON users(last_active_at DESC);
CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_auth_provider ON users(auth_provider) WHERE auth_provider IS NOT NULL;

-- ============================================================
-- Assistant control plane
-- ============================================================

CREATE TABLE assistants (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_bot_id BIGINT,
  assistant_bot_token TEXT,
  assistant_bot_username TEXT,
  litellm_user_id TEXT,
  litellm_key_alias TEXT,
  litellm_virtual_key TEXT,
  litellm_key_last4 TEXT,
  litellm_spend_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  litellm_budget_usd NUMERIC(18, 6),
  litellm_budget_duration TEXT,
  litellm_rpm_limit INTEGER,
  litellm_tpm_limit INTEGER,
  litellm_last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistants_owner_bot_unique UNIQUE NULLS NOT DISTINCT (owner_user_id, assistant_bot_id)
);

CREATE INDEX idx_assistants_bot_id ON assistants(assistant_bot_id) WHERE assistant_bot_id IS NOT NULL;
CREATE INDEX idx_assistants_bot_token ON assistants(assistant_bot_token) WHERE assistant_bot_token IS NOT NULL;
CREATE INDEX idx_assistants_owner_created ON assistants(owner_user_id, created_at DESC);
CREATE INDEX idx_assistants_litellm_key_alias ON assistants(litellm_key_alias);
CREATE INDEX idx_assistants_litellm_user_id ON assistants(litellm_user_id);

-- ============================================================
-- Runtime instances (container / Fly machine state)
-- ============================================================

CREATE TABLE runtime_instances (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'assistant')),
  runtime_provider TEXT NOT NULL CHECK (runtime_provider IN ('docker', 'fly')),
  container_name TEXT NOT NULL,
  runtime_ref TEXT,
  host_port BIGINT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'running', 'stopped', 'suspended', 'error', 'idle', 'missing')),
  last_active_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope = 'user' AND assistant_id IS NULL)
    OR
    (scope = 'assistant' AND assistant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_runtime_user_scope_unique
  ON runtime_instances(owner_user_id) WHERE scope = 'user';
CREATE UNIQUE INDEX idx_runtime_assistant_scope_unique
  ON runtime_instances(assistant_id) WHERE assistant_id IS NOT NULL;
CREATE UNIQUE INDEX idx_runtime_container_name_unique
  ON runtime_instances(container_name);
CREATE UNIQUE INDEX idx_runtime_runtime_ref_unique
  ON runtime_instances(runtime_ref) WHERE runtime_ref IS NOT NULL AND runtime_ref <> '';
CREATE UNIQUE INDEX idx_runtime_host_port_unique
  ON runtime_instances(host_port) WHERE host_port IS NOT NULL;
CREATE INDEX idx_runtime_instances_owner_scope ON runtime_instances(owner_user_id, scope);
CREATE INDEX idx_runtime_instances_status ON runtime_instances(status);
CREATE INDEX idx_runtime_instances_idle_scan
  ON runtime_instances(status, last_active_at) WHERE status = 'running' AND last_active_at IS NOT NULL;

-- ============================================================
-- Gateway sessions
-- ============================================================

CREATE TABLE gateway_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE CASCADE,
  session_token TEXT UNIQUE NOT NULL,
  telegram_username_snapshot TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gateway_sessions_user_id ON gateway_sessions(user_id);
CREATE INDEX idx_gateway_sessions_assistant_id ON gateway_sessions(assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX idx_gateway_sessions_expires_at ON gateway_sessions(expires_at);

-- ============================================================
-- Payment sessions
-- ============================================================

CREATE TABLE payment_sessions (
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

CREATE INDEX idx_payment_sessions_user_id ON payment_sessions(user_id);
CREATE INDEX idx_payment_sessions_assistant_id ON payment_sessions(assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX idx_payment_sessions_expires_at ON payment_sessions(expires_at);

-- ============================================================
-- Billing plans (seed data)
-- ============================================================

CREATE TABLE billing_plans (
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

CREATE INDEX idx_billing_plans_active_order ON billing_plans(is_active, sort_order);

INSERT INTO billing_plans (
  plan_code, display_name, stripe_price_id, currency,
  price_cents_monthly, daily_refresh_credits, monthly_refresh_credits,
  sort_order, is_active
) VALUES
  ('basic', 'Basic', 'price_1T50rb2K5fzHJAlc2maOE5fP', 'usd', 3900, 0, 3200, 10, TRUE),
  ('pro',   'Pro',   'price_1T50rc2K5fzHJAlcTYU5PxtX', 'usd', 9900, 0, 12800, 20, TRUE),
  ('max',   'Max',   'price_1T50rd2K5fzHJAlc4WmBNvPy', 'usd', 19900, 0, 28800, 30, TRUE)
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

-- ============================================================
-- Subscription periods (Stripe billing cycle tracking)
-- ============================================================

CREATE TABLE subscription_periods (
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
  reset_spend_on_apply BOOLEAN DEFAULT TRUE,
  budget_applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscription_periods_unique_sub_period
    UNIQUE (stripe_subscription_id, period_start)
);

CREATE UNIQUE INDEX idx_subscription_periods_stripe_invoice_id
  ON subscription_periods (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX idx_subscription_periods_stripe_customer_id
  ON subscription_periods (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_subscription_periods_apply_budget
  ON subscription_periods (period_start, period_end, budget_applied_at) WHERE budget_applied_at IS NULL;
CREATE INDEX idx_subscription_periods_user_period
  ON subscription_periods (user_id, period_start, period_end);
CREATE INDEX idx_subscription_periods_assistant_id
  ON subscription_periods (assistant_id) WHERE assistant_id IS NOT NULL;

-- ============================================================
-- Stripe subscription event watermarks
-- ============================================================

CREATE TABLE stripe_subscription_event_watermarks (
  stripe_subscription_id TEXT PRIMARY KEY,
  last_event_created BIGINT NOT NULL,
  last_event_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscription_event_watermarks_updated_at
  ON stripe_subscription_event_watermarks (updated_at DESC);

-- ============================================================
-- Payment events
-- ============================================================

CREATE TABLE payment_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assistant_id BIGINT REFERENCES assistants(id) ON DELETE SET NULL,
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  processing_status TEXT NOT NULL DEFAULT 'processing'
    CHECK (processing_status IN ('processing', 'processed', 'failed')),
  error_message TEXT,
  raw_data JSONB,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_events_user_created ON payment_events(user_id, created_at DESC);
CREATE INDEX idx_payment_events_type_created ON payment_events(event_type, created_at DESC);
CREATE INDEX idx_payment_events_processing_status ON payment_events(processing_status);
CREATE INDEX idx_payment_events_assistant_id ON payment_events(assistant_id) WHERE assistant_id IS NOT NULL;

-- ============================================================
-- User pending actions
-- ============================================================

CREATE TABLE user_pending_actions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('token_input')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, action_type)
);

CREATE INDEX idx_user_pending_actions_user_id ON user_pending_actions(user_id);
CREATE INDEX idx_user_pending_actions_expires_at ON user_pending_actions(expires_at);

-- ============================================================
-- VNC access tokens
-- ============================================================

CREATE TABLE vnc_access_tokens (
  id SERIAL PRIMARY KEY,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  used_from_ip VARCHAR(45)
);

CREATE INDEX idx_vnc_access_tokens_assistant_id ON vnc_access_tokens(assistant_id);
CREATE INDEX idx_vnc_access_tokens_token ON vnc_access_tokens(token);
CREATE INDEX idx_vnc_access_tokens_expires_at ON vnc_access_tokens(expires_at);

-- ============================================================
-- Google OAuth
-- ============================================================

CREATE TABLE google_oauth_states (
  state_token TEXT PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  next_path TEXT NOT NULL DEFAULT '/mini',
  code_verifier TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_google_oauth_states_expires_at ON google_oauth_states (expires_at DESC);

CREATE TABLE google_oauth_credentials (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  id_token_enc TEXT,
  token_type TEXT,
  scope TEXT,
  expiry_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_google_oauth_credentials_telegram_user_id
  ON google_oauth_credentials (telegram_user_id);

-- ============================================================
-- Cleanup function
-- ============================================================

CREATE OR REPLACE FUNCTION cleanup_expired_vnc_tokens()
RETURNS void AS $$
BEGIN
  DELETE FROM vnc_access_tokens WHERE expires_at < NOW() - INTERVAL '24 hours';
  DELETE FROM user_pending_actions WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Triggers
-- ============================================================

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_assistants_updated_at
  BEFORE UPDATE ON assistants FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_runtime_instances_updated_at
  BEFORE UPDATE ON runtime_instances FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_billing_plans_updated_at
  BEFORE UPDATE ON billing_plans FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_subscription_event_watermarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vnc_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_oauth_credentials ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'assistants', 'runtime_instances',
    'gateway_sessions', 'payment_sessions',
    'billing_plans', 'subscription_periods',
    'stripe_subscription_event_watermarks',
    'payment_events', 'user_pending_actions',
    'vnc_access_tokens', 'google_oauth_states',
    'google_oauth_credentials'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')',
      'service_role_all_' || t, t
    );
  END LOOP;
END $$;
