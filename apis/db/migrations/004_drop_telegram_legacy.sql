-- 004_drop_telegram_legacy.sql
-- Contract step: drop schema that supported the Telegram bot / claw-assistant
-- product line. Proactive AI uses Supabase Auth (users.supabase_user_id) and
-- generic runtime_instances (scope='user'); the application code no longer
-- references any of the columns/tables removed below.
--
-- Safe because the corresponding code was deleted in the same release:
--   * controllers: auth_routes, user_routes, claw_assistant_routes,
--     dashboard_routes, container_routes, vnc_routes
--   * domains: auth, telegram, telegram-bot, telegram-router, claw-assistant,
--     google-oauth, onboarding, user
--   * payment subscriptionSync was stubbed out

-- 1. Drop FK columns first so dependent tables can survive their parent.
ALTER TABLE runtime_instances     DROP COLUMN IF EXISTS assistant_id;
ALTER TABLE payment_sessions      DROP COLUMN IF EXISTS assistant_id;
ALTER TABLE payment_sessions      DROP COLUMN IF EXISTS telegram_username_snapshot;
ALTER TABLE subscription_periods  DROP COLUMN IF EXISTS assistant_id;
ALTER TABLE payment_events        DROP COLUMN IF EXISTS assistant_id;

-- runtime_instances.scope used to support 'assistant'; only 'user' remains.
ALTER TABLE runtime_instances DROP CONSTRAINT IF EXISTS runtime_instances_scope_check;
ALTER TABLE runtime_instances ADD  CONSTRAINT runtime_instances_scope_check CHECK (scope = 'user');

-- 2. Drop legacy tables (CASCADE clears RLS policies + indexes).
DROP TABLE IF EXISTS vnc_access_tokens         CASCADE;
DROP TABLE IF EXISTS google_oauth_credentials  CASCADE;
DROP TABLE IF EXISTS google_oauth_states       CASCADE;
DROP TABLE IF EXISTS gateway_sessions          CASCADE;
DROP TABLE IF EXISTS user_pending_actions      CASCADE;
DROP TABLE IF EXISTS assistants                CASCADE;

-- 3. Drop the cleanup function that referenced the deleted vnc table.
DROP FUNCTION IF EXISTS cleanup_expired_vnc_tokens();

-- 4. Strip Telegram identity columns from the users table.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_telegram_user_id_check;
ALTER TABLE users DROP COLUMN     IF EXISTS telegram_user_id;
ALTER TABLE users DROP COLUMN     IF EXISTS telegram_username;

-- 5. The users.litellm_* columns are kept: proactive-ai's litellm_key_service
--    still reads litellm_virtual_key / litellm_user_id / litellm_key_alias /
--    litellm_key_last4 / litellm_budget_usd, and the dormant payment module
--    references the rest. They become dead weight only after payment is
--    rewired to query LiteLLM directly.
