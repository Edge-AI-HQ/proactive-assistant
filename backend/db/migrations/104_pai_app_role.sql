-- pai_app — non-BYPASSRLS application role so RLS policies actually fire.
--
-- The problem this fixes (architecture review P0-2):
-- The app pool connects as the `postgres` superuser, which has BYPASSRLS —
-- it ignores every policy AND `FORCE ROW LEVEL SECURITY`. So the per-user
-- policies in 023_pai_rls.sql have NEVER been evaluated; tenant isolation
-- relied entirely on each repository remembering `WHERE user_id = …`. One
-- missing WHERE = silent cross-tenant leak with no DB-level backstop.
--
-- Phase-1 fix (this migration + 105_force_rls.sql + libs/db/rls.py):
--   * `user_scoped_tx` does `SET LOCAL ROLE pai_app` before setting
--     app.user_id. A superuser that `SET ROLE`s to a non-BYPASSRLS role
--     becomes subject to RLS for the duration of the transaction; the role
--     RESETs automatically at COMMIT/ROLLBACK, so the pooled connection is
--     never left downgraded.
--   * `service_tx` does `SET LOCAL ROLE service_role` so the service_role
--     fallback policies (023) fire for ops / scheduler / webhook paths.
--
-- pai_app is NOLOGIN on purpose: in phase 1 it is only ever entered via the
-- superuser doing `SET ROLE`, never connected to directly. Phase 2 (the fly
-- per-app split that gives agent-engine its own scoped DSN, P0-1) is when an
-- operator sets `ALTER ROLE pai_app LOGIN PASSWORD …` and the pool connects
-- as pai_app directly. Until then there is no password to leak.
--
-- Grants below are deliberately broad (all tables/sequences in public): the
-- security boundary is RLS, not column/table GRANTs. pai_app may touch any
-- table, but FORCE RLS (105) + the per-user policies (023) constrain *which
-- rows* — the same model Supabase uses for its `authenticated` role.

-- ── pai_app role ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pai_app') THEN
    -- NOLOGIN: entered only via superuser SET ROLE in phase 1 (see header).
    CREATE ROLE pai_app NOLOGIN;
  END IF;
END$$;

GRANT USAGE ON SCHEMA public TO pai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pai_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pai_app;

-- Future tables (migrations after 104, owner=postgres) must auto-grant to
-- pai_app, otherwise user_scoped_tx hitting a new table fails with
-- "permission denied". DEFAULT PRIVILEGES only apply to objects created by
-- the role that runs this statement (postgres = the migration runner = the
-- owner of every pai_* table), which is exactly the set we need.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pai_app;

-- ── service_role table grants ─────────────────────────────────────────
-- service_role was created in 023 (NOLOGIN) and referenced by the fallback
-- RLS policies, but it has NEVER been granted any table privileges — nobody
-- ever connected/SET ROLE'd as service_role before this change (service_tx
-- previously ran as the superuser and let BYPASSRLS carry it). Now that
-- service_tx does `SET LOCAL ROLE service_role`, the role needs real table
-- access or every ops/scheduler/webhook query fails with "permission
-- denied". Grant the same broad surface; the service_role fallback policies
-- (023, gated on app.user_id being unset) decide row visibility.
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;
