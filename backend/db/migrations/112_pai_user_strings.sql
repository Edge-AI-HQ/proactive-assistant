-- L2 profile — the resident markdown portrait, one row per (user, slot).
--
-- The agent's always-in-context view of the user. Seven sections, but only
-- SIX live here: AGENTS (the safety/behaviour constant) is a CODE constant in
-- agent-engine — never on disk, so neither the user nor the agent's tools can
-- touch it. The six DB-backed slots split by who maintains them:
--   * IDENTITY / SOUL / TOOLS — user-customized (seeded from a default
--     template; edited through the settings UI, wrapped <untrusted-text> at
--     injection time to defang multi-tenant prompt injection).
--   * USER / MEMORY / GOALS   — agent-maintained via memory_edit.
--
-- content is the hermes-style entry block (§-delimited entries). version is an
-- optimistic lock: memory_edit reads (content, version), computes the new
-- content, and writes WHERE version = <read> — a concurrent edit bumps version
-- and the write no-ops, forcing a re-read (no lost updates). char_budget caps
-- the slot; an over-budget add fails and returns all entries so the agent
-- consolidates (the hermes anti-truncation contract).
--
-- Rows are created lazily on first edit/read (UPSERT), so an empty profile is
-- just an absent row, not a table seed.

CREATE TABLE pai_user_strings (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot        TEXT NOT NULL
              CHECK (slot IN ('IDENTITY', 'SOUL', 'TOOLS', 'USER', 'MEMORY', 'GOALS')),
  content     TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  char_budget INTEGER NOT NULL DEFAULT 4000,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, slot)
);

-- RLS — per-user scope, empty-string-safe (NULLIF, 106) + service_role
-- fallback + FORCE (105). New table post-104 → pai_app auto-granted.
ALTER TABLE pai_user_strings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_user_strings FORCE ROW LEVEL SECURITY;

CREATE POLICY pai_user_strings_user_scope ON pai_user_strings
  FOR ALL TO PUBLIC
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint);

CREATE POLICY pai_user_strings_service_role ON pai_user_strings
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
