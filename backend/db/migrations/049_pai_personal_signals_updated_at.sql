-- Track content/status updates separately from first ingest time.
--
-- `ingested_at` remains the original insert timestamp. Upsert-style device
-- rows, especially transcript candidate windows, use `updated_at` for the
-- last server-side mutation time.

ALTER TABLE pai_personal_signals
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pai_psignals_kind_updated_at
  ON pai_personal_signals (user_id, kind, updated_at DESC);
