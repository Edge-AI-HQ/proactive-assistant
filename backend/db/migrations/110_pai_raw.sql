-- L0 unified raw archive — every connector/device/ambient source lands here.
--
-- Supersedes the split storage from 016-019 (typed pai_raw_* per toolkit) +
-- 090 (pai_raw_events generic long-tail): ONE generic table for ALL sources.
-- Envelope columns mirror 090 (the proven generic shape: toolkit / entity_type
-- / external_id / occurred_at / ingested_at / dedupe_key + reference tracking);
-- every source-specific field lives in payload JSONB; title/snippet are
-- optional display projections extracted per recipe (title_path/snippet_path).
--
-- New vs 090: expires_at for reference-aware TTL — L0 is the archive layer, old
-- low-reference rows age out while high-reference rows are kept (see evolve /
-- forgetting in the lifelong-memory plan §七).
--
-- The "toolkit" column name is kept (reused verbatim from 090's generic
-- machinery: generic_ingest.upsert_generic / pinai_db.raw_sources registry /
-- raw_agent reader) rather than renamed to "source" — it carries gmail / gcal /
-- device / ambient alike. The design doc's coarser "source" concept lives one
-- layer up at L1 pai_events.source (the source CATEGORY, not the connector).
--
-- This is the expand step: pai_raw is created alongside the legacy typed +
-- pai_raw_events tables (dropped later in the contract step). Per the "可重抽"
-- decision, connector ingest switches its writes straight to pai_raw (no dual
-- write); the legacy tables simply stop receiving new rows.

CREATE TABLE pai_raw (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT   NOT NULL,
  toolkit            TEXT   NOT NULL,
  entity_type        TEXT   NOT NULL,
  external_id        TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ,
  title              TEXT,
  snippet            TEXT,
  payload            JSONB  NOT NULL,
  dedupe_key         TEXT   NOT NULL,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB  NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);

-- Idempotent re-ingest: one row per (user, toolkit, entity, source item).
CREATE UNIQUE INDEX idx_pai_raw_dedupe
  ON pai_raw (user_id, toolkit, entity_type, dedupe_key);

-- Window reads (reader filters user+toolkit+entity, orders by recency).
CREATE INDEX idx_pai_raw_window
  ON pai_raw (user_id, toolkit, entity_type, occurred_at DESC);

-- TTL sweep: find expired rows cheaply (partial index, only rows with a TTL).
CREATE INDEX idx_pai_raw_ttl
  ON pai_raw (expires_at) WHERE expires_at IS NOT NULL;

-- RLS — per-user scope, empty-string-safe (NULLIF, see 106) + service_role
-- fallback (same shape as 090). New table is created post-104 by the postgres
-- migration runner, so 104's ALTER DEFAULT PRIVILEGES auto-grants pai_app /
-- service_role; FORCE so the postgres owner is constrained too (see 105, whose
-- dynamic sweep ran before this table existed and won't revisit it).
ALTER TABLE pai_raw ENABLE ROW LEVEL SECURITY;
ALTER TABLE pai_raw FORCE ROW LEVEL SECURITY;

CREATE POLICY pai_raw_user_scope ON pai_raw
  FOR ALL TO PUBLIC
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::bigint);

CREATE POLICY pai_raw_service_role ON pai_raw
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
