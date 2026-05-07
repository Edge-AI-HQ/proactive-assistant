-- Consolidate the two task queues onto pai_scheduled_tasks.
--
-- Background: 015 introduced pai_background_tasks (the OpenClaw plugin's
-- single-process queue, with attempts / lease / heartbeat / progress).
-- 021 introduced pai_scheduled_tasks (the new web-process scheduler with
-- SKIP LOCKED claim + per-fire run rows). The two coexisted while the
-- plugin retired. With OpenClaw shut down (docker-compose retired comment)
-- the 015 queue has no worker — connector.init rows enqueued by
-- /api/composio/wait sit forever in 'queued'. This migration finishes the
-- handoff.
--
-- Pre-launch, no users — drop the legacy tables outright instead of
-- expand-contract. Add the fields scheduled_tasks needs to subsume the
-- once-shot job role (retry, progress, last_error). Run rows already
-- carry lease + idempotency, no schema change there.
--
-- Note: pai_connector_sync_cursors stays. It's business data (last-synced
-- watermark per (toolkit, account)), not scheduler internals — used by
-- connector.sync once that handler lands.

DROP TABLE IF EXISTS pai_task_attempts;
DROP TABLE IF EXISTS pai_background_task_schedules;
DROP TABLE IF EXISTS pai_background_tasks;

ALTER TABLE pai_scheduled_tasks
  ADD COLUMN attempts     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN progress     JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN last_error   TEXT;
