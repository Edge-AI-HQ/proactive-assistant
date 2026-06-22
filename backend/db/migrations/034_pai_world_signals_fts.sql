-- World signals: keyword full-text + dependencies for hybrid search.
--
-- Phase 2 of the world-stream port from the OpenClaw plugin.
-- pgvector cosine (HNSW index) is already built by 029. This migration
-- adds the keyword side: a GENERATED tsvector column over title + summary,
-- plus a GIN index on it. The /api/agent/world/search endpoint runs both
-- searches in parallel and combines them via Reciprocal Rank Fusion.
--
-- Why STORED tsvector instead of expression index:
--   * GIN over a function-call expression must re-evaluate on every
--     write, but the expression is computed twice (insert + index update).
--     A GENERATED STORED column computes once and the index reads from it.
--   * Easier to inspect: SELECT title_summary_tsv shows the actual lexemes.
--
-- Why English config:
--   * RSS sources we ingest (Google News WORLD/BUSINESS, SEC, Fed) are
--     English-only. If we add CJK sources later, switch to a multi-lang
--     config (or build a separate column per language).

ALTER TABLE pai_world_signals
  ADD COLUMN IF NOT EXISTS title_summary_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_pai_world_signals_tsv
  ON pai_world_signals USING gin (title_summary_tsv);
