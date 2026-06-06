-- pai_user_settings.proactive_interval_seconds — how often the proactive
-- heartbeat fires (the interval of the per-user `proactive.tick` scheduler task).
--
-- Default 300 (5 min). Users pick one of three buckets in Settings (1 / 5 / 30
-- min); routes/ui/profile.py mirrors the value into the proactive.tick task's
-- interval_seconds on a settings write (_sync_proactive_schedule) and repairs a
-- stale interval on a settings read (_ensure_proactive_schedule) — so an
-- existing tick row re-syncs to the user's choice the next time settings are
-- read, no backfill migration needed.
--
-- Seconds (not minutes like auto_generate) leaves room for finer buckets later.
-- The CHECK pins the exact UI buckets so a buggy/malicious client can't create
-- a runaway heartbeat; the floor is 60s (a 30s cadence flooded the agent + LLM).
-- Additive: the DEFAULT backfills every existing row to 5 min.

ALTER TABLE pai_user_settings
  ADD COLUMN proactive_interval_seconds INT NOT NULL DEFAULT 300
    CHECK (proactive_interval_seconds IN (60, 300, 1800));
