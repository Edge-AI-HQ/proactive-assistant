-- High-weight user preference records.
--
-- The expression layer of feedback: preferences the user (or an internal
-- operator acting on their behalf) stated in plain words in main chat.
-- Distinct from pai_feedback_events (behavior layer — confirm / dismiss /
-- snooze) and pai_profile (aggregated persona). Generation reads active
-- rows and treats recent + high-weight ones as near-hard constraints.
--
-- State machine mirrors pai_memory:
--   active → superseded   (a newer preference replaces this; superseded_by
--                          points at the new id)
--   active → archived     (no longer current)
--
-- `source` is server-enforced by principal (see web/routes/agent/preferences.py):
--   user              — the account owner stated it in their own chat
--   internal_operator — an internal reviewer补 it via impersonation
--   agent             — agent-derived (reserved; not written by the current
--                       main-chat path)
-- The agent never self-reports source — the route stamps it from the JWT.

CREATE TABLE pai_preference_records (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  statement     TEXT NOT NULL,
  scope         TEXT NOT NULL,
  polarity      TEXT NOT NULL,
  weight        REAL NOT NULL,
  confidence    REAL,
  source        TEXT NOT NULL,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id),
  CHECK (scope IN ('topic', 'source', 'timing', 'format', 'global')),
  CHECK (polarity IN ('positive', 'negative')),
  CHECK (source IN ('user', 'internal_operator', 'agent')),
  CHECK (status IN ('active', 'superseded', 'archived'))
);

CREATE INDEX idx_pai_preference_records_status
  ON pai_preference_records (user_id, status, created_at DESC);
CREATE INDEX idx_pai_preference_records_scope
  ON pai_preference_records (user_id, scope, status);

-- RLS — same pattern as 023_pai_rls.sql.
ALTER TABLE pai_preference_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_preference_records_user_scope ON pai_preference_records
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_preference_records_service_role ON pai_preference_records
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
