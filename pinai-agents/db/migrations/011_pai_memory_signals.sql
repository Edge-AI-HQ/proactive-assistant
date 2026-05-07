-- Memory v3 ledger + personal signals + feedback events.
-- 1:1 from plugin proactive.db: memory, personal_signals, feedback_events.
-- v3 ledger semantics preserved (status state machine + supersede chain +
-- reference triple). Personal signals state machine
-- (open → consumed → archived) preserved verbatim — generator depends on it.

CREATE TABLE pai_memory (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  text               TEXT NOT NULL,
  source             TEXT NOT NULL,
  source_run_id      TEXT,
  subject            TEXT,
  quality            REAL NOT NULL DEFAULT 0.5,
  confidence         REAL NOT NULL DEFAULT 0.5,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'archived', 'superseded')),
  superseded_by      TEXT,
  occurred_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tags               JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_pai_memory_status_quality
  ON pai_memory (user_id, status, quality DESC);
CREATE INDEX idx_pai_memory_subject_created
  ON pai_memory (user_id, subject, created_at DESC);
CREATE INDEX idx_pai_memory_source_run
  ON pai_memory (user_id, source_run_id);

CREATE TABLE pai_personal_signals (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  salience           REAL NOT NULL DEFAULT 0,
  confidence         REAL NOT NULL DEFAULT 0,
  dedupe_key         TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  available_at       TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ,
  source             TEXT NOT NULL DEFAULT 'device',
  device_id          TEXT,
  subject            TEXT,
  source_raw_table   TEXT,
  source_raw_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'consumed', 'archived')),
  consumed_by_run_id TEXT,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
-- Dedupe is per-user — same dedupe_key across users is fine and expected.
CREATE UNIQUE INDEX idx_pai_psignals_dedupe
  ON pai_personal_signals (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_psignals_status_time
  ON pai_personal_signals (user_id, status, occurred_at DESC);
CREATE INDEX idx_pai_psignals_kind_time
  ON pai_personal_signals (user_id, kind, occurred_at DESC);

CREATE TABLE pai_feedback_events (
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               TEXT NOT NULL,
  kind             TEXT NOT NULL,
  action           TEXT,
  push_id          TEXT,
  intent_card_id   TEXT,
  intent_key       TEXT,
  source           TEXT NOT NULL DEFAULT 'user_direct',
  basket           TEXT,
  value            TEXT,
  text             TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  conversation_id  TEXT,
  message_id       TEXT,
  channel          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_pai_feedback_created
  ON pai_feedback_events (user_id, created_at DESC);
