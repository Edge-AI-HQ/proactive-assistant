-- Generic raw-event storage for long-tail / inferred / custom connectors.
--
-- The 9 legacy toolkits (gmail/gcal/gdrive/slack/github/calendly/stripe/
-- youtube/linkedin) keep their typed pai_raw_* tables; every other toolkit
-- lands here. A toolkit's storage is exclusively one or the other — the
-- routing truth is _RAW_TABLES in web/routes/agent/raw.py.
--
-- Envelope columns mirror the typed tables (id / occurred_at / ingested_at /
-- dedupe_key / reference tracking) so the shared reader + reference-count
-- machinery work unchanged. Source-specific fields live in payload JSONB;
-- title/snippet are optional display projections extracted per recipe
-- (title_path / snippet_path), NULL when the recipe declares none.

CREATE TABLE pai_raw_events (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT   NOT NULL,
  toolkit            TEXT   NOT NULL,
  entity_type        TEXT   NOT NULL,
  external_id        TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
CREATE UNIQUE INDEX idx_pai_raw_events_dedupe
  ON pai_raw_events (user_id, toolkit, entity_type, dedupe_key);

-- Window reads (reader filters user+toolkit+entity, orders by recency).
CREATE INDEX idx_pai_raw_events_window
  ON pai_raw_events (user_id, toolkit, entity_type, occurred_at DESC);

-- RLS: standard per-user policy pair (same shape as 023_pai_rls.sql).
ALTER TABLE pai_raw_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_raw_events_user_scope ON pai_raw_events
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_raw_events_service_role ON pai_raw_events
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
