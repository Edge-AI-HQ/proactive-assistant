-- Card reward ledger + internal review casebook + trace artifacts.
--
-- This is intentionally additive. User-side card opens / scores and
-- internal reviewer scores land in the same append-only ledger, while the
-- current score is derived at query time.

CREATE TABLE pai_card_reward_events (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  card_id      TEXT NOT NULL,
  source       TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  score        REAL,
  reason       TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id),
  CHECK (source IN ('user', 'reviewer', 'system')),
  CHECK (event_type IN (
    'card_open',
    'user_score',
    'reviewer_score',
    'dismiss',
    'imported_feedback'
  )),
  CHECK (score IS NULL OR (score >= 0 AND score <= 10)),
  CHECK (
    event_type NOT IN ('user_score', 'reviewer_score')
    OR score IS NOT NULL
  ),
  CHECK (
    event_type NOT IN ('user_score', 'reviewer_score')
    OR score >= 1
  )
);

CREATE INDEX idx_pai_card_reward_run
  ON pai_card_reward_events (user_id, run_id, created_at DESC);
CREATE INDEX idx_pai_card_reward_card
  ON pai_card_reward_events (user_id, card_id, created_at DESC);
CREATE INDEX idx_pai_card_reward_source_type
  ON pai_card_reward_events (user_id, source, event_type, created_at DESC);

CREATE TABLE pai_card_casebook (
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id              TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  card_id         TEXT NOT NULL,
  label           TEXT NOT NULL,
  score_snapshot  REAL,
  reviewer_note   TEXT,
  snapshot        JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, card_id),
  CHECK (label IN (
    'great',
    'bad',
    'surprising',
    'generic',
    'hallucinated',
    'duplicate',
    'mistimed',
    'weak_source'
  )),
  CHECK (score_snapshot IS NULL OR (score_snapshot >= 0 AND score_snapshot <= 10))
);

CREATE INDEX idx_pai_card_casebook_run
  ON pai_card_casebook (user_id, run_id);
CREATE INDEX idx_pai_card_casebook_label_updated
  ON pai_card_casebook (user_id, label, updated_at DESC);

CREATE TABLE pai_trace_artifacts (
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL,
  langsmith_trace_id  TEXT,
  status              TEXT NOT NULL,
  trace_tree          JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary             JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_format        TEXT NOT NULL DEFAULT 'svg',
  image_path          TEXT,
  error               TEXT,
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, run_id),
  CHECK (status IN ('pending', 'ready', 'missing', 'failed')),
  CHECK (image_format IN ('svg', 'png'))
);

CREATE INDEX idx_pai_trace_artifacts_status
  ON pai_trace_artifacts (user_id, status, generated_at DESC);

-- RLS - same policy pair as 023_pai_rls.sql for newly added per-user tables.
ALTER TABLE pai_card_reward_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_card_reward_events_user_scope ON pai_card_reward_events
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_card_reward_events_service_role ON pai_card_reward_events
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

ALTER TABLE pai_card_casebook ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_card_casebook_user_scope ON pai_card_casebook
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_card_casebook_service_role ON pai_card_casebook
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

ALTER TABLE pai_trace_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_trace_artifacts_user_scope ON pai_trace_artifacts
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_trace_artifacts_service_role ON pai_trace_artifacts
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
