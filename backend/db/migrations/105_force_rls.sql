-- FORCE ROW LEVEL SECURITY on every RLS-enabled pai_* table.
--
-- Why FORCE is required (not just ENABLE):
-- ENABLE ROW LEVEL SECURITY exempts the table OWNER from its own policies.
-- Every pai_* table is owned by `postgres` (the migration runner), so the
-- moment any code touches a table as the owner, RLS is silently skipped.
-- After 104 + libs/db/rls.py, user_scoped_tx runs as `pai_app` and
-- service_tx as `service_role` — neither is the owner, so ENABLE alone
-- would already make policies fire for them. But FORCE closes the gap for
-- ANY owner-context access (future code, manual ops, a pai_* table that
-- ends up owned by a role we SET ROLE into) and makes "is RLS actually
-- enforced here?" answerable as a table property instead of depending on
-- who happens to be connected. It is the standard hardening step paired
-- with ENABLE for defense-in-depth tables.
--
-- Note: BYPASSRLS roles (the `postgres` superuser the pool still connects
-- as) ignore FORCE too — that is the whole reason phase 1 downgrades via
-- SET ROLE. FORCE matters for the downgraded roles and for owner context.
--
-- Dynamically enumerate so this stays correct as tables are added/removed
-- from the RLS set: any table in `public` with relrowsecurity already true
-- and a pai_ prefix. This picks up all per-user tables from 023 plus
-- pai_world_signals (shared: public-read + service_role-write policies, so
-- FORCE changes nothing for its legitimate paths). users / pai_yoyo_* /
-- non-RLS tables are skipped because they never had RLS enabled.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = TRUE
      AND c.relname LIKE 'pai_%'
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END$$;
