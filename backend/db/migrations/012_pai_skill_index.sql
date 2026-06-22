-- Skill index — agent-discoverable skills written by crystallize / dream agent.
-- 1:1 from plugin proactive.db skill_index. Body markdown lives separately
-- (Step 0b moves to Storage); this table is the metadata + search index.

CREATE TABLE pai_skill_index (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'enabled'
                       CHECK (status IN ('enabled', 'disabled', 'archived')),
  revision             INTEGER NOT NULL DEFAULT 1,
  body_hash            TEXT NOT NULL,
  triggers             JSONB NOT NULL DEFAULT '[]'::jsonb,
  source               TEXT NOT NULL,
  created_run_id       TEXT,
  last_updated_run_id  TEXT,
  enabled_at           TIMESTAMPTZ,
  disabled_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_pai_skill_index_status
  ON pai_skill_index (user_id, status, updated_at DESC);
