-- Auto-generate cadence: how often to fire the recurring `generator`
-- scheduled task when `auto_generate = TRUE`. Frontend exposes preset
-- buckets (30 / 60 / 120 / 240 / 720 / 1440 min); CHECK is the server
-- safety net so a forged request can't schedule sub-15min storms.
ALTER TABLE pai_user_settings
  ADD COLUMN auto_generate_interval_minutes INT NOT NULL DEFAULT 60
    CHECK (auto_generate_interval_minutes BETWEEN 15 AND 1440);
