-- Make the per-user RLS policies empty-string-safe.
--
-- Why this is needed (surfaced by 104/105 making RLS actually evaluate):
-- The 023 per-user policy predicate is
--     user_id = current_setting('app.user_id', true)::bigint
-- Postgres custom GUCs have a quirk: once `set_config('app.user_id', …,
-- is_local => true)` runs in ANY transaction on a connection, the GUC stays
-- DEFINED for the rest of that session and reverts to the EMPTY STRING ''
-- (not NULL) when the local value unwinds at COMMIT — RESET / set_config(NULL)
-- can't clear it, only DISCARD ALL can (which a pooled connection can't run
-- mid-transaction). So the very next service_tx on that pooled connection
-- sees app.user_id = '' and the policy tries `''::bigint`, which throws
-- `invalid input syntax for type bigint: ""` BEFORE the service_role
-- fallback policy (OR'd in) can rescue the row. This was invisible until now
-- because the pool connected as the BYPASSRLS superuser, which skipped
-- policy evaluation entirely; 104/105 + libs/db/rls.py downgrade to
-- non-BYPASSRLS roles, so the predicate finally runs and the cast blows up.
--
-- Fix: NULLIF(current_setting('app.user_id', true), '')::bigint. Empty string
-- becomes NULL, `user_id = NULL` is just false/unknown (no row, no error),
-- which is the correct fail-closed behavior. This is the same null-guard
-- Supabase / PostgREST use for session-GUC RLS. The service_role fallback
-- policies (023) already test `IS NULL OR = ''` so they need no change.
--
-- We DROP + recreate only the `<table>_user_scope` policy on each table that
-- already has it, enumerated dynamically (same table set as 023, kept in
-- sync by reading pg_policy instead of re-listing). Policy DROP/CREATE is the
-- only way to alter a policy expression; this is additive at the migration
-- level (new forward-only file), it does not edit 023.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND p.polname = c.relname || '_user_scope'
    ORDER BY c.relname
  LOOP
    EXECUTE format('DROP POLICY %I ON %I', t || '_user_scope', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        FOR ALL TO PUBLIC
        USING (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
        WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
    $f$, t || '_user_scope', t);
  END LOOP;
END$$;
