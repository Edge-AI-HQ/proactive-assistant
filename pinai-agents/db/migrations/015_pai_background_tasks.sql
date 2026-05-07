-- Plugin's historical background_tasks queue + recurring schedules + per-attempt
-- audit + connector sync cursors. 1:1 from proactive.db.
--
-- Note: this is the *plugin* queue (durable single-process scheduler the
-- OpenClaw container ran). Step SCH adds a separate pai_scheduled_tasks /
-- pai_scheduled_task_runs pair (021) for the new scheduler module living
-- in the web process. Both coexist during transition; eventually 015 moves
-- to deprecated as plugin retires.

CREATE TABLE pai_background_tasks (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  type                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN
                              ('queued', 'running', 'succeeded', 'failed',
                               'timed_out', 'cancelled', 'lost', 'skipped')),
  priority             INTEGER NOT NULL DEFAULT 50,
  run_after            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key      TEXT NOT NULL,
  payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress             JSONB NOT NULL DEFAULT '{}'::jsonb,
  result               JSONB,
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 3,
  lease_owner          TEXT,
  lease_token          TEXT,
  lease_expires_at     TIMESTAMPTZ,
  heartbeat_at         TIMESTAMPTZ,
  last_error_code      TEXT,
  last_error_message   TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX idx_pai_bgtasks_due
  ON pai_background_tasks (user_id, status, run_after, priority, created_at);
CREATE INDEX idx_pai_bgtasks_lease
  ON pai_background_tasks (user_id, status, lease_expires_at);
CREATE INDEX idx_pai_bgtasks_type_created
  ON pai_background_tasks (user_id, type, created_at DESC);

CREATE TABLE pai_background_task_schedules (
  user_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                     TEXT NOT NULL,
  type                   TEXT NOT NULL,
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  schedule_kind          TEXT NOT NULL
                         CHECK (schedule_kind IN ('interval', 'daily_local', 'manual')),
  schedule               JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_template       JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_template   TEXT NOT NULL,
  priority               INTEGER NOT NULL DEFAULT 50,
  max_attempts           INTEGER NOT NULL DEFAULT 3,
  next_run_at            TIMESTAMPTZ,
  last_enqueued_at       TIMESTAMPTZ,
  last_task_id           TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_pai_bgsched_due
  ON pai_background_task_schedules (user_id, enabled, next_run_at, priority);

CREATE TABLE pai_task_attempts (
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  attempt_no     INTEGER NOT NULL,
  worker_id      TEXT NOT NULL,
  lease_token    TEXT NOT NULL,
  status         TEXT NOT NULL
                 CHECK (status IN
                        ('running', 'succeeded', 'failed', 'timed_out', 'lost')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at   TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  error_code     TEXT,
  error_message  TEXT,
  logs           JSONB,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, task_id, attempt_no)
);
CREATE INDEX idx_pai_attempt_status_started
  ON pai_task_attempts (user_id, status, started_at DESC);

CREATE TABLE pai_connector_sync_cursors (
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  toolkit               TEXT NOT NULL,
  connected_account_id  TEXT NOT NULL,
  last_synced_at        TIMESTAMPTZ NOT NULL,
  toolkit_cursor        JSONB,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, toolkit, connected_account_id)
);
