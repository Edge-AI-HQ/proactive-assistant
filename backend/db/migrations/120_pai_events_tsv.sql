-- World full-migration W1: give pai_events a keyword (tsvector) lane so
-- events_search can go HYBRID (semantic + keyword, RRF-fused). This matches the
-- power of world_search (hybrid keyword+semantic) before world's专用 read API is
-- retired (world-migration spec §障碍1) — and benefits ALL events, not just
-- world_news (a query like "OpenAI billing" now keyword-matches event titles, not
-- just cosine-near ones).
--
-- title_body_tsv is a STORED GENERATED column: postgres recomputes it on every
-- insert/update of title/body, so it never drifts and needs no app-side wiring.
-- GIN index accelerates the @@ plainto_tsquery lookup in search_keyword.

ALTER TABLE pai_events
  ADD COLUMN title_body_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) STORED;

CREATE INDEX idx_pai_events_tsv ON pai_events USING gin (title_body_tsv);
