-- Users table — owned by pinai-agents (was apis baseline).
--
-- Naming: lex-sorted before 010_pai_core_state.sql so the FK
-- `REFERENCES users(id) ON DELETE CASCADE` in every pai_* table resolves
-- on a fresh database. Existing dev/prod databases already have a users
-- table from apis baseline; the IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- pattern makes this a no-op there.
--
-- Column scope is intentionally narrow — only what pinai-agents code
-- reads or writes today:
--   * identity:      id, supabase_user_id, email, display_name, avatar_url
--   * activity:      created_at, updated_at, last_active_at
--   * litellm:       litellm_virtual_key (web/services/litellm_provisioning.py
--                    is the only writer; we don't carry over the apis-era
--                    user_id / alias / last4 / spend / budget bookkeeping
--                    columns since LiteLLM itself is the source of truth)
--   * stripe:        stripe_customer_id (web/payment/subscriptions.py)
--
-- Other apis-era columns (telegram_*, gateway_token, container_proxy_secret,
-- litellm_rpm/tpm_limit, etc.) were either dropped by apis's own migration
-- chain or by 030_drop_legacy_user_columns.sql.

CREATE TABLE IF NOT EXISTS users (
  id                   BIGSERIAL PRIMARY KEY,
  supabase_user_id     UUID UNIQUE,
  email                TEXT,
  display_name         TEXT,
  avatar_url           TEXT,
  litellm_virtual_key  TEXT,
  stripe_customer_id   TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ALTERs are idempotent so this migration also smooths over partial
-- legacy schemas (e.g. apis baseline had stripe_customer_id added later).
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_user_id    UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS litellm_virtual_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- supabase_user_id is the natural key for `ON CONFLICT DO UPDATE`.
-- If the column was added later (legacy schema without it) the ALTER
-- above creates it but doesn't add the unique index — do that here.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND contype = 'u'
      AND conname = 'users_supabase_user_id_key'
  ) THEN
    -- Use a unique INDEX (not constraint) so partial / null-tolerant
    -- behavior matches Postgres defaults; multiple users with NULL
    -- supabase_user_id are allowed (e.g. seed accounts).
    CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_user_id_key
      ON users (supabase_user_id)
      WHERE supabase_user_id IS NOT NULL;
  END IF;
END $$;
