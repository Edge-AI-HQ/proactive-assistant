-- User-level LiteLLM shared key model
-- Each user owns one LiteLLM virtual key and all assistants under this user reuse it.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS litellm_key_alias TEXT,
  ADD COLUMN IF NOT EXISTS litellm_virtual_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS litellm_key_last4 TEXT,
  ADD COLUMN IF NOT EXISTS litellm_spend_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS litellm_budget_usd NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS litellm_budget_duration TEXT,
  ADD COLUMN IF NOT EXISTS litellm_rpm_limit INTEGER,
  ADD COLUMN IF NOT EXISTS litellm_tpm_limit INTEGER,
  ADD COLUMN IF NOT EXISTS litellm_last_synced_at TIMESTAMPTZ;

-- Backfill user-level key fields from the newest assistant key under the same owner.
WITH assistant_key_source AS (
  SELECT DISTINCT ON (a.owner_user_id)
    a.owner_user_id,
    a.litellm_user_id,
    a.litellm_key_alias,
    a.litellm_virtual_key_encrypted,
    a.litellm_key_last4,
    a.litellm_spend_usd,
    a.litellm_budget_usd,
    a.litellm_budget_duration,
    a.litellm_rpm_limit,
    a.litellm_tpm_limit,
    a.litellm_last_synced_at
  FROM assistants a
  WHERE a.litellm_virtual_key_encrypted IS NOT NULL
    AND BTRIM(a.litellm_virtual_key_encrypted) <> ''
  ORDER BY a.owner_user_id, a.updated_at DESC, a.id DESC
)
UPDATE users u
SET
  litellm_user_id = COALESCE(u.litellm_user_id, s.litellm_user_id),
  litellm_key_alias = COALESCE(u.litellm_key_alias, s.litellm_key_alias),
  litellm_virtual_key_encrypted = COALESCE(u.litellm_virtual_key_encrypted, s.litellm_virtual_key_encrypted),
  litellm_key_last4 = COALESCE(u.litellm_key_last4, s.litellm_key_last4),
  litellm_spend_usd = CASE
    WHEN u.litellm_virtual_key_encrypted IS NULL OR BTRIM(u.litellm_virtual_key_encrypted) = ''
      THEN COALESCE(s.litellm_spend_usd, u.litellm_spend_usd)
    ELSE u.litellm_spend_usd
  END,
  litellm_budget_usd = COALESCE(u.litellm_budget_usd, s.litellm_budget_usd),
  litellm_budget_duration = COALESCE(u.litellm_budget_duration, s.litellm_budget_duration),
  litellm_rpm_limit = COALESCE(u.litellm_rpm_limit, s.litellm_rpm_limit),
  litellm_tpm_limit = COALESCE(u.litellm_tpm_limit, s.litellm_tpm_limit),
  litellm_last_synced_at = COALESCE(u.litellm_last_synced_at, s.litellm_last_synced_at),
  updated_at = NOW()
FROM assistant_key_source s
WHERE u.id = s.owner_user_id;

CREATE INDEX IF NOT EXISTS idx_users_litellm_key_alias
  ON users (litellm_key_alias)
  WHERE litellm_key_alias IS NOT NULL AND litellm_key_alias <> '';

COMMIT;
