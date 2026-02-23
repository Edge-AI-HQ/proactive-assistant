-- Compatibility migration for legacy databases where users/assistants tables
-- existed before unified LiteLLM columns were introduced.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS litellm_user_id TEXT,
  ADD COLUMN IF NOT EXISTS litellm_user_alias TEXT,
  ADD COLUMN IF NOT EXISTS litellm_key_alias TEXT,
  ADD COLUMN IF NOT EXISTS litellm_virtual_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS litellm_key_last4 TEXT,
  ADD COLUMN IF NOT EXISTS litellm_spend_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS litellm_budget_usd NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS litellm_budget_duration TEXT,
  ADD COLUMN IF NOT EXISTS litellm_rpm_limit INTEGER,
  ADD COLUMN IF NOT EXISTS litellm_tpm_limit INTEGER,
  ADD COLUMN IF NOT EXISTS litellm_last_synced_at TIMESTAMPTZ;

ALTER TABLE assistants
  ADD COLUMN IF NOT EXISTS litellm_user_id TEXT,
  ADD COLUMN IF NOT EXISTS litellm_key_alias TEXT,
  ADD COLUMN IF NOT EXISTS litellm_virtual_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS litellm_key_last4 TEXT,
  ADD COLUMN IF NOT EXISTS litellm_spend_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS litellm_budget_usd NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS litellm_budget_duration TEXT,
  ADD COLUMN IF NOT EXISTS litellm_rpm_limit INTEGER,
  ADD COLUMN IF NOT EXISTS litellm_tpm_limit INTEGER,
  ADD COLUMN IF NOT EXISTS litellm_last_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_litellm_user_id_unique
  ON users (litellm_user_id)
  WHERE litellm_user_id IS NOT NULL AND litellm_user_id <> '';

CREATE INDEX IF NOT EXISTS idx_users_litellm_key_alias
  ON users (litellm_key_alias)
  WHERE litellm_key_alias IS NOT NULL AND litellm_key_alias <> '';

CREATE INDEX IF NOT EXISTS idx_assistants_litellm_key_alias ON assistants(litellm_key_alias);
CREATE INDEX IF NOT EXISTS idx_assistants_litellm_user_id ON assistants(litellm_user_id);

COMMIT;
