-- pgvector + embeddings for semantic memory search.
--
-- Approach: store the embedding alongside each memory row. Compute on
-- insert via a background task (so write latency stays bounded). Query
-- via cosine distance using an HNSW index. Embedding model is the
-- LiteLLM-routed text-embedding-3-small (1536 dims) — cheap, fast,
-- competitive accuracy on short text.
--
-- Why pgvector vs a separate vector DB:
--   * Same Postgres connection, RLS scoping comes for free.
--   * < 100k rows / user — well within pgvector's sweet spot.
--   * One less moving piece in ops.
--
-- Indexing strategy:
--   * HNSW (graph-based, low memory, fast queries) — better than IVFFlat
--     for our row counts. ef_construction=64 / m=16 are pgvector defaults.
--   * Per-(user_id, embedding) opclass — RLS already scopes the SELECT,
--     so we don't need user_id in the index key; but include it in WHERE
--     to short-circuit before the vector op.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── pai_memory: embedding column ──
ALTER TABLE pai_memory ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE pai_memory ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE pai_memory ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pai_memory_embedding_hnsw
  ON pai_memory USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- ── pai_personal_signals: embedding column (signals are also queryable) ──
ALTER TABLE pai_personal_signals ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE pai_personal_signals ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE pai_personal_signals ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pai_personal_signals_embedding_hnsw
  ON pai_personal_signals USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- ── pai_world_signals: embedding column ──
ALTER TABLE pai_world_signals ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE pai_world_signals ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE pai_world_signals ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pai_world_signals_embedding_hnsw
  ON pai_world_signals USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- ── Embedding queue ──
-- Background task picks up rows with embedding IS NULL, calls LiteLLM
-- /embeddings, writes back. Single queue table because the work is
-- the same regardless of source — we just key by (table, id).
CREATE TABLE pai_embedding_queue (
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_name   TEXT NOT NULL
               CHECK (table_name IN ('pai_memory', 'pai_personal_signals', 'pai_world_signals')),
  row_id       TEXT NOT NULL,
  text         TEXT NOT NULL,        -- snapshot at enqueue time
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, table_name, row_id)
);

CREATE INDEX idx_pai_embedding_queue_pending
  ON pai_embedding_queue (status, enqueued_at)
  WHERE status = 'pending';

ALTER TABLE pai_embedding_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_embedding_queue_user_scope ON pai_embedding_queue
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_embedding_queue_service_role ON pai_embedding_queue
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
