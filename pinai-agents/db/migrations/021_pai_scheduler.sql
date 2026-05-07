-- Scheduler module (Step SCH).
-- pai_scheduled_tasks (kind 枚举 / cron / interval) + pai_scheduled_task_runs
-- (lease + idempotency).
--
-- Distinct from pai_background_tasks (015): that table is the plugin's
-- historical work queue; this pair is the new scheduler module living in
-- the web process. The two coexist while plugin retires.

CREATE TABLE pai_scheduled_tasks (
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               TEXT NOT NULL,
  -- 'auto.dreaming' | 'connector.evolve' | 'connector.init' | 'crystallize'
  -- | 'user.prompt'. Open enum (no CHECK) — agents can register new kinds
  -- without schema migration; dispatcher routes by kind in code.
  kind             TEXT NOT NULL,
  name             TEXT,
  prompt           TEXT,
  trigger_kind     TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'event', 'once')),
  cron_expr        TEXT,
  interval_seconds INTEGER,
  event_filter     JSONB,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  timezone         TEXT NOT NULL DEFAULT 'UTC',
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'paused', 'archived')),
  next_run_at      TIMESTAMPTZ,
  last_run_at      TIMESTAMPTZ,
  last_run_status  TEXT,
  run_count        INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);
-- Partial index for the SKIP LOCKED claim hot path: scheduler tick scans
-- only rows that are active AND have a due time. Excludes paused / once-fired /
-- event-triggered (next_run_at IS NULL until enqueued).
CREATE INDEX idx_pai_sched_due
  ON pai_scheduled_tasks (next_run_at, status)
  WHERE status = 'active' AND next_run_at IS NOT NULL;
CREATE INDEX idx_pai_sched_user_kind
  ON pai_scheduled_tasks (user_id, kind);

CREATE TABLE pai_scheduled_task_runs (
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  scheduled_for     TIMESTAMPTZ NOT NULL,
  fired_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agent_run_id      TEXT,
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  status            TEXT NOT NULL,                              -- queued|running|success|failed
  error             TEXT,
  PRIMARY KEY (user_id, id),
  -- Idempotency: same task fired for the same scheduled time is a no-op.
  -- Dispatcher writes this row before starting work; race losers see
  -- conflict and abort.
  UNIQUE (user_id, task_id, scheduled_for)
);
CREATE INDEX idx_pai_schedrun_lease
  ON pai_scheduled_task_runs (status, lease_expires_at)
  WHERE status = 'running';
CREATE INDEX idx_pai_schedrun_task
  ON pai_scheduled_task_runs (user_id, task_id, fired_at DESC);
