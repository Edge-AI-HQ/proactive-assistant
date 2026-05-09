-- Default auto-generate cards: ON, every 12h.
--
-- Only changes the column DEFAULT — existing rows keep whatever the
-- user (or prior default) set, so this is safe for accounts that have
-- already opened Preferences. New rows (lazy-created on first
-- /api/settings hit, or via upsert COALESCE fallback) land at
-- TRUE / 720min straight away.
ALTER TABLE pai_user_settings
  ALTER COLUMN auto_generate SET DEFAULT TRUE;

ALTER TABLE pai_user_settings
  ALTER COLUMN auto_generate_interval_minutes SET DEFAULT 720;
