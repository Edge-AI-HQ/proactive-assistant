-- World signals — DELIBERATE DIVERGENCE from plugin per-user table.
-- News / external context is the same across users; only the per-user
-- relevance score differs. Splitting into:
--   * pai_world_signals: globally-shared store (no user_id), keyed by
--     normalized_url. Ingest runs once for everyone.
--   * pai_world_signal_user_view: per-user projection with profile-scored
--     salience and consume status.
-- Storage savings + shared ingest worth the extra join.

CREATE TABLE pai_world_signals (
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  stream_type        TEXT NOT NULL DEFAULT 'search',
  title              TEXT NOT NULL,
  url                TEXT NOT NULL,
  normalized_url     TEXT NOT NULL UNIQUE,
  external_id        TEXT,
  summary            TEXT,
  published_at       TIMESTAMPTZ,
  search_queries     JSONB NOT NULL DEFAULT '[]'::jsonb,
  topics             JSONB NOT NULL DEFAULT '[]'::jsonb,
  regions            JSONB NOT NULL DEFAULT '[]'::jsonb,
  importance         TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pai_world_signals_published
  ON pai_world_signals (published_at DESC);
CREATE INDEX idx_pai_world_signals_provider
  ON pai_world_signals (provider, published_at DESC);

-- Per-user projection. Holds personalization + lifecycle state.
-- reference triple stays per-user (each user's evolution runs reference
-- their own view rows).
CREATE TABLE pai_world_signal_user_view (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  world_signal_id      TEXT NOT NULL REFERENCES pai_world_signals(id) ON DELETE CASCADE,
  salience             REAL NOT NULL DEFAULT 0,
  -- Lifecycle: 'new' (just scored) | 'open' (active) | 'consumed' | 'archived'
  status               TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new', 'open', 'consumed', 'archived')),
  consumed_by_run_id   TEXT,
  scored_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scored_reason        TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, world_signal_id)
);
CREATE INDEX idx_pai_wsuv_user_status_salience
  ON pai_world_signal_user_view (user_id, status, salience DESC);
CREATE INDEX idx_pai_wsuv_user_scored
  ON pai_world_signal_user_view (user_id, scored_at DESC);
