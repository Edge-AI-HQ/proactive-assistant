-- Make the litellm schema grant (127) independent of deploy order.
--
-- 127 is guarded on the litellm schema / token table already existing. On a
-- brand-new database the api's release_command runs yoyo BEFORE LiteLLM has
-- ever booted, so the schema (created by LiteLLM's Prisma) is not there yet:
-- 127 is a no-op and never re-runs. Hit on the 2026-11 prod rebuild — every key
-- mint logs "litellm budget reset timestamp sync failed" (non-fatal since the
-- #233 SAVEPOINT, but the reset timestamp never syncs).
--
--   1. Create the schema if absent. LiteLLM's Prisma reuses an existing schema,
--      so the grants below no longer depend on whether LiteLLM booted first.
--   2. ALTER DEFAULT PRIVILEGES: tables later created in litellm by this role
--      (postgres — the role LiteLLM connects as too) get SELECT, UPDATE for
--      service_role / pai_app. Same verbs as 127; the table scope is wider (any
--      litellm table, not only LiteLLM_VerificationToken) because default
--      privileges cannot target one table name. The api already holds
--      LITELLM_MASTER_KEY, so this exposes nothing new to it.
--   3. Re-grant the token table where LiteLLM already created it before this
--      migration (prod after the rebuild).
--
-- Every statement is idempotent.

CREATE SCHEMA IF NOT EXISTS litellm;

GRANT USAGE ON SCHEMA litellm TO service_role, pai_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA litellm
  GRANT SELECT, UPDATE ON TABLES TO service_role, pai_app;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'litellm' AND table_name = 'LiteLLM_VerificationToken'
  ) THEN
    EXECUTE 'GRANT SELECT, UPDATE ON litellm."LiteLLM_VerificationToken" '
            'TO service_role, pai_app';
  END IF;
END$$;
