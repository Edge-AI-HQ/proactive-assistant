-- Normalize LiteLLM identity mapping to internal users.id
-- 1) LiteLLM user_id = users.id::text
-- 2) Assistant key alias prefix = claw-assistant-
-- 3) Reset assistant virtual keys + spend snapshots to force clean regeneration
--    under the new identity model.

BEGIN;

-- Avoid transient unique collisions during remap.
UPDATE users
SET litellm_user_id = NULL
WHERE litellm_user_id IS NOT NULL;

UPDATE users
SET
  litellm_user_id = users.id::text,
  litellm_user_alias = COALESCE(
    NULLIF(BTRIM(users.litellm_user_alias), ''),
    CASE
      WHEN users.telegram_username IS NOT NULL AND BTRIM(users.telegram_username) <> ''
        THEN CONCAT('telegram:', users.telegram_user_id::text, ':@', BTRIM(users.telegram_username))
      ELSE CONCAT('telegram:', users.telegram_user_id::text)
    END
  ),
  updated_at = NOW(),
  last_active_at = NOW()
WHERE
  users.litellm_user_id IS DISTINCT FROM users.id::text
  OR users.litellm_user_alias IS NULL
  OR BTRIM(users.litellm_user_alias) = '';

UPDATE assistants AS a
SET
  litellm_user_id = u.id::text,
  litellm_key_alias = CONCAT('claw-assistant-', a.assistant_bot_id),
  litellm_virtual_key_encrypted = NULL,
  litellm_key_last4 = NULL,
  litellm_spend_usd = 0,
  litellm_budget_usd = NULL,
  litellm_budget_duration = NULL,
  litellm_rpm_limit = NULL,
  litellm_tpm_limit = NULL,
  litellm_last_synced_at = NULL,
  updated_at = NOW()
FROM users AS u
WHERE a.owner_user_id = u.id;

UPDATE user_credit_wallets
SET
  last_litellm_spend_cents = 0,
  updated_at = NOW()
WHERE last_litellm_spend_cents <> 0;

COMMIT;
