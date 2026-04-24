-- Each Supabase user owns one long-lived Browserbase context so AI browser
-- sessions restore cookies/localStorage between runs. Without this, the
-- agent has to log in to every site from scratch every time, which makes
-- any auth-gated workflow (Gmail, calendar, banking, shopping) unusable.
--
-- One row per user. The Browserbase context_id is opaque to us; we just
-- hand it back to the SDK when creating a session.
--
-- We do not FK supabase_user_id to auth.users — auth is a separate schema
-- managed by Supabase, and the rest of this repo consistently treats
-- supabase_user_id as an opaque identifier (see users.supabase_user_id).

CREATE TABLE IF NOT EXISTS proactive_browser_context (
  supabase_user_id UUID PRIMARY KEY,
  context_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
