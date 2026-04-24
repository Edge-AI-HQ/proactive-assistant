-- Per-Supabase-user binding to a long-lived Browserbase "context" so AI
-- browser sessions restore cookies/localStorage between runs instead of
-- logging in to every site from scratch every time. The context_id is
-- opaque to us; we hand it back to the SDK when creating a session.
--
-- We do not FK supabase_user_id to auth.users — auth is a separate schema
-- managed by Supabase, and the rest of this repo consistently treats
-- supabase_user_id as an opaque identifier (see users.supabase_user_id).
--
-- last_used_at + updated_at are observability-only for a future
-- housekeeping job (Browserbase contexts live forever on their side
-- until explicitly deleted; we want the option to recycle quiet ones).
--
-- Why this is numbered 003 even though the original PR added it as 002:
-- the repo already had 002_user_devices.sql from the memory-architecture
-- work, and the migration runner keys by the 3-char number prefix — the
-- name collision made run-all-migrations.mjs silently skip the second
-- 002 on every deploy since PR #126 merged, so the table was never
-- actually created. Renumbering to 003 + IF NOT EXISTS guards makes
-- this idempotent regardless of whether any environment managed to
-- run the original 002 by hand.

CREATE TABLE IF NOT EXISTS proactive_browser_context (
  supabase_user_id UUID PRIMARY KEY,
  context_id       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ
);

-- Guards for environments that did manage to create the table by hand
-- (either someone ran the old 002 manually, or a future revert path
-- leaves the table behind). Both are no-ops on a fresh install.
ALTER TABLE proactive_browser_context
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
