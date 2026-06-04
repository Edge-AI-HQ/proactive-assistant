-- Product development suggestions collected from Main Chat.
--
-- This is intentionally separate from pai_feedback_events and
-- pai_preference_records. Feedback/preferences personalize generation for
-- one user; development feedback is product-team triage data for UI,
-- feature, workflow, and settings requests that the agent cannot implement
-- immediately.

CREATE TABLE pai_development_feedback (
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supabase_user_id UUID NOT NULL,
  id               TEXT NOT NULL,
  text             TEXT NOT NULL CHECK (char_length(text) > 0),
  summary          TEXT,
  category         TEXT NOT NULL,
  surface          TEXT NOT NULL DEFAULT 'unknown',
  status           TEXT NOT NULL DEFAULT 'new',
  source           TEXT NOT NULL DEFAULT 'user',
  conversation_id  TEXT,
  message_id       TEXT,
  dedupe_key       TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id),
  CHECK (category IN ('ui', 'feature', 'bug_like', 'workflow', 'settings', 'other')),
  CHECK (surface IN ('main_chat', 'card_detail', 'settings', 'ambient', 'unknown')),
  CHECK (status IN ('new', 'reviewed', 'planned', 'closed')),
  CHECK (source IN ('user', 'internal_operator', 'agent'))
);

CREATE INDEX idx_pai_development_feedback_status
  ON pai_development_feedback (user_id, status, created_at DESC);

CREATE INDEX idx_pai_development_feedback_category
  ON pai_development_feedback (category, status, created_at DESC);

CREATE UNIQUE INDEX idx_pai_development_feedback_dedupe
  ON pai_development_feedback (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- RLS — same per-user pattern as newer per-user pai_* tables.
ALTER TABLE pai_development_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_development_feedback_user_scope ON pai_development_feedback
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_development_feedback_service_role ON pai_development_feedback
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
