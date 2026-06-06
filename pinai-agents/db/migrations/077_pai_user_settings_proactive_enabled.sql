-- Proactive heartbeat opt-in (main chat "Proactive" toggle). The user-facing
-- switch lives here as the intent SSOT; the scheduler only ever wakes from
-- pai_scheduled_tasks, so the settings route mirrors this flag into a per-user
-- `proactive.tick` task (active when true, archived when false). Default OFF —
-- a fresh user runs no background turns until they flip it on.
ALTER TABLE pai_user_settings
  ADD COLUMN proactive_enabled BOOLEAN NOT NULL DEFAULT FALSE;
