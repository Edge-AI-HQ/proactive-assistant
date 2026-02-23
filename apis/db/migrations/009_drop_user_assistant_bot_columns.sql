-- Drop legacy assistant-related columns from users.
-- Source of truth is assistants table, these user-level columns are no longer used.

BEGIN;

DROP INDEX IF EXISTS idx_users_assistant_bot_token_unique;
DROP INDEX IF EXISTS idx_users_assistant_bot_username_unique;

ALTER TABLE users
  DROP COLUMN IF EXISTS assistant_bot_token,
  DROP COLUMN IF EXISTS assistant_bot_username,
  DROP COLUMN IF EXISTS assistant_webhook_secret;

COMMIT;
