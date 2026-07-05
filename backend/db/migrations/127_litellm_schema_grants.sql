-- Grant service_role / pai_app access to the litellm schema so the key-mint
-- path's budget-reset sync can write it.
--
-- Root cause (regression introduced by #197). _provision_and_persist() mints a
-- user's LiteLLM virtual key inside ONE service_tx (SET LOCAL ROLE
-- service_role), doing four writes in sequence:
--     UPDATE users SET litellm_virtual_key   -- the key itself
--     ensure_user_free_subscription()        -- pai_subscriptions
--     ensure_open_period()                   -- pai_budget_periods
--     recompute_litellm_budget()
--        └─ _sync_litellm_budget_reset_at()
--             └─ UPDATE litellm."LiteLLM_VerificationToken"   -- cross-schema!
-- Migration 104 only granted service_role / pai_app the *public* schema. The
-- litellm schema (owned by postgres, populated by the LiteLLM app) was never
-- granted, so that last cross-schema UPDATE raised
--     permission denied for schema litellm
-- The app caught and logged it (checkout.py) — but in PostgreSQL a single
-- failed statement already marks the whole transaction ABORTED, so committing
-- the service_tx silently turned into a ROLLBACK. The freshly-minted key,
-- subscription and budget window all vanished; users.litellm_virtual_key stayed
-- NULL. Downstream, every LLM dispatch (evolve / generate / chat) skips on the
-- missing key. Every user who completed onboarding after #197 was affected.
--
-- Minimal surface: USAGE on the schema + SELECT,UPDATE on the single token
-- table the backend pins directly (_sync_litellm_budget_reset_at). SELECT is
-- required because that UPDATE filters on metadata columns in its WHERE. We do
-- NOT grant INSERT/DELETE — LiteLLM owns the lifecycle of these rows.
--
-- The companion code change wraps the cross-schema write in a SAVEPOINT so that
-- even a future permission gap can never again roll back the key mint.
--
-- Guarded with IF EXISTS: the litellm schema is created by the LiteLLM app
-- (Prisma), which on a brand-new environment's very first deploy may not have
-- run yet. The guard makes this migration a harmless no-op until the schema
-- exists (all current environments already have it). GRANT is idempotent, so
-- re-running is safe.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'litellm') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA litellm TO service_role, pai_app';

    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'litellm' AND table_name = 'LiteLLM_VerificationToken'
    ) THEN
      EXECUTE 'GRANT SELECT, UPDATE ON litellm."LiteLLM_VerificationToken" '
              'TO service_role, pai_app';
    END IF;
  END IF;
END$$;
