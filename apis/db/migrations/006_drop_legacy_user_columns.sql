-- 006_drop_legacy_user_columns.sql
-- Contract step that pairs with 005's expand:
--   * users.gateway_token  → renamed to users.container_proxy_secret in 005.
--                            New code only reads/writes the new column;
--                            this migration drops the legacy one.
--   * users.litellm_rpm_limit / litellm_tpm_limit → never read or written
--                            from current source (verified 2026-04-28).
--                            Were carried over from the deleted Telegram bot
--                            service. LiteLLM stores its own per-key limits.
--
-- Other litellm_* columns (user_id / user_alias / virtual_key / key_alias /
-- key_last4 / spend_usd / budget_usd / budget_duration / last_synced_at) are
-- still actively read/written by the payment domain and the proactive-ai
-- key service, so they stay until payment is rewired to query LiteLLM
-- directly.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gateway_token_key;
ALTER TABLE users DROP COLUMN IF EXISTS gateway_token;

ALTER TABLE users DROP COLUMN IF EXISTS litellm_rpm_limit;
ALTER TABLE users DROP COLUMN IF EXISTS litellm_tpm_limit;
