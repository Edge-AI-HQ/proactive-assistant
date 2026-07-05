-- L1 event stream — the immutable, bi-temporal semantic layer (events_search).
--
-- pai_raw (L0) is the verbatim archive; pai_events (L1) is the projected
-- semantic event stream the agent actually retrieves over. Append-only:
-- history is never mutated in place — a correction/replacement appends a new
-- row and links the old one via supersedes_id / superseded_by_id (the system
-- sets the back-pointer; the agent only ever appends).
--
-- Two time axes (bi-temporal, the single most-cited thing to keep from the
-- research): occurred_at = when the event happened in reality (+ end_at for
-- intervals like meetings); recorded_at = when the system learned it. "When
-- was this superseded" is answered by the superseding row's recorded_at, so we
-- do NOT carry a separate valid_from/valid_to (those belong to fact edges in a
-- graph; events are not fact edges — see the design doc's fact simplification).
--
-- Events are NOT deduplicated by content: the same action at different times
-- is N distinct rows (that frequency IS the signal evolve distils into the L2
-- profile). dedupe_key only guards the same event being written twice (e.g. a
-- backfill and a webhook both catching one email).
--
-- structured JSONB holds typed fields + confidence; source_ref points back to
-- the L0 row (or names a natural-language source). importance / curation_status
-- start at projector defaults and are refined by evolve (importance / rollup /
-- forgetting). embedding mirrors the pai_memory shape (029): cosine HNSW.

CREATE TABLE pai_events (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT   NOT NULL,
  source             TEXT   NOT NULL,            -- category: composio / device / ambient / chat / pinai_feedback
  event_type         TEXT   NOT NULL,            -- communication / meeting / utterance / movement / transaction / interaction / agent_decision / preference
  occurred_at        TIMESTAMPTZ NOT NULL,
  end_at             TIMESTAMPTZ,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  title              TEXT,
  body               TEXT,
  structured         JSONB  NOT NULL DEFAULT '{}'::jsonb,
  source_ref         TEXT,
  importance         REAL   NOT NULL DEFAULT 0.5,
  curation_status    TEXT   NOT NULL DEFAULT 'pending'
                     CHECK (curation_status IN ('pending', 'active', 'filtered_out', 'archived')),
  supersedes_id      TEXT,
  superseded_by_id   TEXT,
  dedupe_key         TEXT   NOT NULL,
  embedding          vector(1536),
  embedding_model    TEXT,
  embedded_at        TIMESTAMPTZ,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id)
);

-- Idempotent projection / append: one row per (user, source item).
CREATE UNIQUE INDEX idx_pai_events_dedupe ON pai_events (user_id, dedupe_key);

-- Time-window retrieval (the dominant access pattern).
CREATE INDEX idx_pai_events_window ON pai_events (user_id, occurred_at DESC);

-- By type (gating / structured filters).
CREATE INDEX idx_pai_events_type ON pai_events (user_id, event_type, occurred_at DESC);

-- Pending sweep (evolve curation picks these up).
CREATE INDEX idx_pai_events_curation ON pai_events (user_id, curation_status)
  WHERE curation_status = 'pending';

-- Projector idempotency: "has this L0 row already been projected?"
CREATE INDEX idx_pai_events_source_ref ON pai_events (user_id, source_ref)
  WHERE source_ref IS NOT NULL;

-- Semantic search — cosine HNSW, same shape as pai_memory (029).
CREATE INDEX idx_pai_events_embedding_hnsw
  ON pai_events USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- RLS — per-user scope, empty-string-safe (NULLIF, 106) + service_role
-- fallback + FORCE (105). New table post-104 → pai_app auto-granted.
ALTER TABLE pai_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_events FORCE ROW LEVEL SECURITY;

CREATE POLICY pai_events_user_scope ON pai_events
  FOR ALL TO PUBLIC
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint);

CREATE POLICY pai_events_service_role ON pai_events
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

-- Let the shared embedding pipeline (platform/embeddings.py drain_queue) write
-- vectors back to pai_events. 029 pinned table_name to the original three; widen
-- it. The constraint is the auto-named inline CHECK from 029.
ALTER TABLE pai_embedding_queue
  DROP CONSTRAINT IF EXISTS pai_embedding_queue_table_name_check;
ALTER TABLE pai_embedding_queue
  ADD CONSTRAINT pai_embedding_queue_table_name_check
  CHECK (table_name IN ('pai_memory', 'pai_personal_signals', 'pai_world_signals', 'pai_events'));

-- Drop the dead pai_timeline_events table (064, never had a producer) — the
-- L1 event stream supersedes the idea it stood for.
DROP TABLE IF EXISTS pai_timeline_events CASCADE;
