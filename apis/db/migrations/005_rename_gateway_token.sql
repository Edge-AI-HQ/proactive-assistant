-- 005_rename_gateway_token.sql
-- Expand step: rename users.gateway_token → users.container_proxy_secret.
--
-- The original column name was misleading: "gateway_token" sounded like a
-- user-facing session token, but it's actually the per-user secret APIs uses
-- to authenticate when proxying requests to the user's OpenClaw gateway
-- (server-to-container). The new name reflects that role.
--
-- Expand-contract:
--   * This migration adds the new column, backfills, and makes the OLD
--     column nullable so new code can stop writing to it.
--   * Code in this release dual-writes (gateway_token + container_proxy_secret)
--     so a rollback to the previous release continues to function.
--   * A follow-up migration (006) will DROP the gateway_token column once
--     this release is fully rolled out.

ALTER TABLE users ADD COLUMN IF NOT EXISTS container_proxy_secret TEXT;

UPDATE users
   SET container_proxy_secret = gateway_token
 WHERE container_proxy_secret IS NULL;

ALTER TABLE users ALTER COLUMN container_proxy_secret SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'users_container_proxy_secret_unique'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_container_proxy_secret_unique UNIQUE (container_proxy_secret);
  END IF;
END$$;

-- Allow new code to skip the legacy column without breaking the constraint.
ALTER TABLE users ALTER COLUMN gateway_token DROP NOT NULL;

COMMENT ON COLUMN users.container_proxy_secret IS
  'Per-user secret used by the APIs proxy to authenticate to the user container''s OpenClaw gateway (server-to-container). Renamed from gateway_token. Migration 006 drops gateway_token.';
