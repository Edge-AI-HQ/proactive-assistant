-- Drop pai_world_signals' dead embedding / FTS / write-only columns
-- (L0 raw-layer review — all write-only after W6).
--
-- W6 retired per-user world retrieval to pai_events (event_type='world_news').
-- Since then world's own embedding (029) + FTS (034) columns are NEVER read —
-- vector + keyword search run entirely on pai_events. The embedding queue was
-- still paying to embed every RSS row into a column no one reads; world_ingest
-- no longer enqueues (same release), so we drop the dead columns + their
-- indexes here.
--
-- Also dropped: stream_type / search_queries / metadata / external_id — only
-- ever written by ingest, never read by world_scoring (the sole reader, which
-- reads id/title/summary/url/provider/topics/regions/importance/published_at).
--
-- DROP COLUMN cascades each column's index:
--   * idx_pai_world_signals_embedding_hnsw (029, HNSW on embedding)
--   * idx_pai_world_signals_tsv            (034, GIN on title_summary_tsv)
-- Kept columns (provider/title/summary/url/normalized_url/published_at/topics/
-- regions/importance/created_at/updated_at) are world_scoring's projection
-- inputs. This is an expand-contract contract step (DROP is the additive-only
-- break, authorized by the user) — the writers stopped writing these columns in
-- the same release.

-- Purge any world rows still pending in the embedding queue so the now
-- events-only drain worker never tries to UPDATE the dropped columns.
DELETE FROM pai_embedding_queue WHERE table_name = 'pai_world_signals';

ALTER TABLE pai_world_signals
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_model,
  DROP COLUMN IF EXISTS embedded_at,
  DROP COLUMN IF EXISTS title_summary_tsv,
  DROP COLUMN IF EXISTS stream_type,
  DROP COLUMN IF EXISTS search_queries,
  DROP COLUMN IF EXISTS metadata,
  DROP COLUMN IF EXISTS external_id;
