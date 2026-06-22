-- Raw device data uploaded by iOS / Android clients via /devices/ingest.
-- 1:1 from raw-db.ts. Note: device ingest webhook stays in plugin during this
-- consolidation (see plan § 不在本计划内). backend reads these tables
-- but doesn't write them yet.

-- ── Device installed-app inventory snapshots ──
CREATE TABLE pai_raw_device_apps_snapshot (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  snapshot_id        TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  bundle_id          TEXT NOT NULL,
  app_name           TEXT NOT NULL,
  version            TEXT,
  last_used_at       TIMESTAMPTZ,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX idx_pai_raw_device_apps_dedupe
  ON pai_raw_device_apps_snapshot (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_device_apps_captured
  ON pai_raw_device_apps_snapshot (user_id, device_id, occurred_at DESC);

-- ── Device contacts snapshots ──
CREATE TABLE pai_raw_device_contacts_snapshot (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  snapshot_id        TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  display_name       TEXT,
  emails             JSONB NOT NULL DEFAULT '[]'::jsonb,
  phones             JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_modified      TIMESTAMPTZ,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX idx_pai_raw_device_contacts_dedupe
  ON pai_raw_device_contacts_snapshot (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_device_contacts_captured
  ON pai_raw_device_contacts_snapshot (user_id, device_id, occurred_at DESC);

-- ── Device health observations (covers samples / summaries / sleep / workouts /
-- alerts; observation_type is the discriminator). local_date stays a calendar
-- date for "today" / "this-week" type queries; occurred_at is the canonical
-- ordering timestamp.
CREATE TABLE pai_raw_device_health_observations (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  observation_type   TEXT NOT NULL,
  metric             TEXT,
  value              REAL,
  unit               TEXT,
  start_at           TIMESTAMPTZ,
  end_at             TIMESTAMPTZ,
  local_date         DATE,
  source_app         TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX idx_pai_raw_device_health_dedupe
  ON pai_raw_device_health_observations (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_device_health_device_time
  ON pai_raw_device_health_observations (user_id, device_id, occurred_at DESC);
CREATE INDEX idx_pai_raw_device_health_metric_time
  ON pai_raw_device_health_observations (user_id, metric, occurred_at DESC);
CREATE INDEX idx_pai_raw_device_health_local_date
  ON pai_raw_device_health_observations (user_id, device_id, local_date);
