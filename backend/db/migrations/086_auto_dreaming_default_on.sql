-- Default auto-dreaming: ON.
--
-- Mirrors 038 (auto_generate default ON). Only changes the column
-- DEFAULT — existing rows keep whatever the user (or prior default)
-- set, so accounts that already opened Preferences are untouched.
-- New rows (lazy-created on first /api/settings hit, or via upsert
-- COALESCE fallback) land at TRUE straight away, and the next profile
-- read fires _ensure_auto_dreaming_schedule to create the daily 06:00 task.
ALTER TABLE pai_user_settings
  ALTER COLUMN auto_dreaming SET DEFAULT TRUE;
