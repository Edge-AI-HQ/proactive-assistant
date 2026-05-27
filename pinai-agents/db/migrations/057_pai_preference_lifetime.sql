-- Add lifetime semantics to stated preferences.
--
-- `temporary` rows are immediate generation guidance with an expiry
-- (for example "today show me AI news"). `persistent` rows can also be
-- promoted into pai_profile.preferences by the chat agent.

ALTER TABLE pai_preference_records
  ADD COLUMN durability TEXT NOT NULL DEFAULT 'persistent',
  ADD COLUMN expires_at TIMESTAMPTZ;

ALTER TABLE pai_preference_records
  ADD CONSTRAINT chk_pai_preference_records_durability
  CHECK (durability IN ('temporary', 'persistent'));

ALTER TABLE pai_preference_records
  ADD CONSTRAINT chk_pai_preference_records_lifetime
  CHECK (
    (durability = 'temporary' AND expires_at IS NOT NULL)
    OR (durability = 'persistent' AND expires_at IS NULL)
  );

CREATE INDEX idx_pai_preference_records_active_valid
  ON pai_preference_records (user_id, status, expires_at, created_at DESC);
