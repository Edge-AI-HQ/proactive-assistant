-- pai_chat needs database-level CREATE for the engine checkpointer bootstrap.
--
-- The engine's AsyncPostgresSaver setup calls _ensure_schema
-- (agent_engine/harness/checkpoint.py), which runs
--   CREATE SCHEMA IF NOT EXISTS "langgraph"
-- Postgres requires the *database* CREATE privilege for CREATE SCHEMA even when
-- the schema already exists — IF NOT EXISTS suppresses the duplicate-object
-- error, NOT the permission check. 024_pai_chat_role.sql granted pai_chat
-- schema-level CREATE on the langgraph schema but never the database-level
-- CREATE, so the engine — once it connects as the scoped pai_chat role after
-- the fly app split (deploy/fly-split/) instead of the superuser DATABASE_URL —
-- crashes at boot with `permission denied for database postgres`. The single
-- app's superuser connection had this privilege implicitly, which is why the
-- gap only surfaced when engine ran under its own scoped DSN.
--
-- This grant lets pai_chat create schemas in the database. Table-level tenant
-- isolation is unchanged: pai_chat still holds ZERO grants on any pai_* / public
-- table (024 REVOKEs public + grants only the langgraph schema), so it cannot
-- read user data — has_table_privilege('pai_chat', 'pai_memory', 'SELECT')
-- stays false. current_database() keeps this portable across dev/test/prod/local.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO pai_chat', current_database());
END$$;
