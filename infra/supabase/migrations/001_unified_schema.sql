-- PIN AI unified schema (core + billing)
-- Target: Supabase Postgres (public schema)

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Core tables (master bot + runtime control)
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  litellm_user_id TEXT,
  litellm_user_alias TEXT,
  container_id TEXT UNIQUE NOT NULL,
  container_port BIGINT UNIQUE NOT NULL,
  container_status TEXT NOT NULL DEFAULT 'creating',
  gateway_token TEXT UNIQUE NOT NULL,
  assistant_bot_token TEXT,
  assistant_bot_username TEXT,
  assistant_webhook_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assistants (
  id BIGSERIAL PRIMARY KEY,
  owner_telegram_user_id BIGINT NOT NULL,
  assistant_bot_id BIGINT UNIQUE NOT NULL,
  assistant_bot_token TEXT UNIQUE NOT NULL,
  assistant_bot_username TEXT UNIQUE NOT NULL,
  litellm_user_id TEXT,
  litellm_key_alias TEXT,
  litellm_virtual_key_encrypted TEXT,
  litellm_key_last4 TEXT,
  litellm_spend_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  litellm_budget_usd DOUBLE PRECISION,
  litellm_budget_duration TEXT,
  litellm_rpm_limit INTEGER,
  litellm_tpm_limit INTEGER,
  litellm_last_synced_at TIMESTAMPTZ,
  container_name TEXT UNIQUE NOT NULL,
  container_id TEXT UNIQUE NOT NULL,
  container_port INTEGER UNIQUE NOT NULL,
  container_status TEXT NOT NULL DEFAULT 'creating',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gateway_sessions (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  session_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS message_logs (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  direction TEXT,
  message_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS token_usage_ledger (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  session_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS user_usage_totals (
  telegram_user_id BIGINT PRIMARY KEY,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Billing tables (payment gateway)
CREATE TABLE IF NOT EXISTS payment_sessions (
  id BIGSERIAL PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  telegram_user_id TEXT NOT NULL,
  telegram_username TEXT,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT UNIQUE NOT NULL,
  telegram_username TEXT,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  docker_container_id TEXT,
  docker_port INTEGER,
  docker_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'paused', 'canceled', 'pending')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT,
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS container_logs (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'started', 'stopped', 'removed', 'error')),
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Triggers
DROP TRIGGER IF EXISTS update_assistants_updated_at ON assistants;
CREATE TRIGGER update_assistants_updated_at
  BEFORE UPDATE ON assistants
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_subscriptions_updated_at ON user_subscriptions;
CREATE TRIGGER update_user_subscriptions_updated_at
  BEFORE UPDATE ON user_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_assistant_bot_token_unique
  ON users (assistant_bot_token)
  WHERE assistant_bot_token IS NOT NULL AND assistant_bot_token != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_assistant_bot_username_unique
  ON users (assistant_bot_username)
  WHERE assistant_bot_username IS NOT NULL AND assistant_bot_username != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_litellm_user_id_unique
  ON users (litellm_user_id)
  WHERE litellm_user_id IS NOT NULL AND litellm_user_id != '';

CREATE INDEX IF NOT EXISTS idx_gateway_sessions_expires_at ON gateway_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_gateway_sessions_user_created ON gateway_sessions(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_user_created ON message_logs(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistants_owner_created ON assistants(owner_telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assistants_litellm_key_alias ON assistants(litellm_key_alias);
CREATE INDEX IF NOT EXISTS idx_assistants_litellm_user_id ON assistants(litellm_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_ledger_user_created ON token_usage_ledger(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_ledger_run_id ON token_usage_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_payment_token ON payment_sessions(token);
CREATE INDEX IF NOT EXISTS idx_payment_expires ON payment_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_used ON payment_sessions(used);
CREATE INDEX IF NOT EXISTS idx_stripe_customer ON user_subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_stripe_subscription ON user_subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_payment_telegram_user ON payment_events(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_payment_event_type ON payment_events(event_type);
CREATE INDEX IF NOT EXISTS idx_payment_created_at ON payment_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_container_telegram_user ON container_logs(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_container_id ON container_logs(container_id);
CREATE INDEX IF NOT EXISTS idx_container_action ON container_logs(action);

-- RLS + service-role policies
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_usage_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE container_logs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users',
    'assistants',
    'gateway_sessions',
    'message_logs',
    'admin_users',
    'admin_sessions',
    'token_usage_ledger',
    'user_usage_totals',
    'payment_sessions',
    'user_subscriptions',
    'payment_events',
    'container_logs'
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
