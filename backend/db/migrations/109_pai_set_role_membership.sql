-- Grant the role memberships that rls.py's SET LOCAL ROLE requires.
--
-- THE BUG (a "tests green, prod broken" gap from the P0-2 RLS rollout):
-- rls.py runs `SET LOCAL ROLE pai_app` (user_scoped_tx) and `SET LOCAL ROLE
-- service_role` (service_tx). Postgres SET ROLE requires the *connecting* role
-- to be a member of the target role WITH the SET privilege. Every P0-2 test
-- passes because local / CI Postgres connects as a TRUE superuser, which can
-- SET ROLE to anything regardless of membership. But on the real deployment:
--   * the api process connects as Supabase `postgres`, which is rolsuper=FALSE
--     and is auto-made a member of new roles WITHOUT the SET privilege (PG16),
--     so `SET ROLE pai_app` fails ("permission denied to set role pai_app") and
--     every user_scoped_tx 500s;
--   * the reward-dashboard process connects as `pai_reward`, which is not a
--     member of pai_app at all, so its user_scoped_tx would 500 the moment that
--     app takes traffic.
-- No test ever exercised a NON-superuser connection, so neither surfaced until
-- the fly app split put the real Supabase roles on the connection path.
--
-- Fix: grant each DB-connecting principal membership in the roles it SET ROLEs
-- into. Plain GRANT (no `WITH SET` clause) keeps this PG15-compatible (CI is
-- pgvector:pg15, where membership alone implies SET); on PG16 (Supabase) an
-- explicit GRANT defaults to WITH SET TRUE — exactly the privilege missing from
-- Supabase's implicit auto-grant of new roles to postgres.
--   api    connects as CURRENT_USER (postgres) → SET ROLE pai_app + service_role
--   reward connects as pai_reward              → SET ROLE pai_app + service_role
--   engine connects as pai_chat                → does NOT use rls.py (no grant)
DO $$
BEGIN
  -- api: the migration runs under the api's own DSN role, so CURRENT_USER is
  -- exactly the role the api connects with. Grant it the SET-ROLE targets.
  EXECUTE format('GRANT pai_app TO %I', CURRENT_USER);
  EXECUTE format('GRANT service_role TO %I', CURRENT_USER);

  -- reward: connects as pai_reward (guarded — an env that hasn't run 107 yet
  -- won't have the role). 107 already granted service_role TO pai_reward; the
  -- re-grant is idempotent and ensures the SET privilege on PG16.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pai_reward') THEN
    GRANT pai_app TO pai_reward;
    GRANT service_role TO pai_reward;
  END IF;
END$$;
