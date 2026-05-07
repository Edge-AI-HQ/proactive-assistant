-- pai_chat DB role — schema-scoped, no public access.
--
-- chat process needs a Postgres connection (LangGraph checkpointer writes
-- thread state). Plan v2 § Trust 边界:chat 不持 service_role. Solution
-- is a least-privilege role:
--   * Read/write everything in `langgraph` schema (LangGraph's own tables)
--   * NOTHING in `public` (where pai_* and users live)
--
-- chat process gets LANGGRAPH_DB_URL using this role; its existence makes
-- prompt-injection-driven cross-user data exfil structurally impossible
-- even before RLS kicks in.
--
-- Local docker-compose dev environments may not have a separate role yet —
-- the run-or-skip logic below makes this idempotent and harmless to apply
-- against a local Postgres that doesn't have a langgraph schema yet.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pai_chat') THEN
    -- Password is intentionally not set here — operators set it via Fly /
    -- Supabase dashboard, then put the connection URL in
    -- LANGGRAPH_DB_URL Fly secret. Local dev compose can ALTER ROLE this
    -- afterwards. Leaving the role passwordless means nobody can connect
    -- as it until an operator explicitly grants access.
    CREATE ROLE pai_chat LOGIN;
  END IF;
END$$;

-- LangGraph schema: full DML + CREATE (LangGraph's AsyncPostgresSaver.setup()
-- creates checkpoints / checkpoint_blobs / checkpoint_writes /
-- checkpoint_migrations tables on first run; chat process is the one that
-- runs setup, so it needs CREATE on the schema).
CREATE SCHEMA IF NOT EXISTS langgraph;
GRANT USAGE, CREATE ON SCHEMA langgraph TO pai_chat;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE
  ON ALL TABLES IN SCHEMA langgraph TO pai_chat;
GRANT USAGE, SELECT, UPDATE
  ON ALL SEQUENCES IN SCHEMA langgraph TO pai_chat;
ALTER DEFAULT PRIVILEGES IN SCHEMA langgraph
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES
  TO pai_chat;
ALTER DEFAULT PRIVILEGES IN SCHEMA langgraph
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES
  TO pai_chat;

-- Public schema is explicitly OFF-LIMITS. We don't even GRANT USAGE on
-- public; chat process can't see pai_* / users tables exist. This is
-- belt-and-suspenders alongside RLS.
REVOKE ALL ON SCHEMA public FROM pai_chat;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pai_chat;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM pai_chat;
