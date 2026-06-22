-- Push notifications: extend pai_user_devices with APNs/FCM token columns,
-- and pai_user_settings with the new-cards notification preference.
--
-- v1 only ships APNs (iOS). push_provider stays open so Android/FCM and
-- web push can plug in later without a schema change.
--
-- push_token is the platform-issued device token (APNs deviceToken on iOS).
-- It refreshes occasionally; clients re-PUT on every app launch and we
-- upsert by (user_id, device_id). push_failure_count is bumped when the
-- send pipeline gets a "BadDeviceToken"-class response; we soft-disable the
-- token at some threshold rather than deleting the row.

ALTER TABLE pai_user_devices
  ADD COLUMN push_token            TEXT,
  ADD COLUMN push_provider         TEXT
                                   CHECK (push_provider IS NULL OR push_provider IN ('apns', 'fcm', 'web')),
  ADD COLUMN push_token_updated_at TIMESTAMPTZ,
  ADD COLUMN push_failure_count    INTEGER NOT NULL DEFAULT 0;

-- Send pipeline lookup: "all push-eligible devices for user X".
CREATE INDEX idx_pai_user_devices_push_active
  ON pai_user_devices (user_id)
  WHERE status = 'active' AND push_token IS NOT NULL;

-- New-cards notification preference. Defaults to FALSE: nothing is sent
-- until the user explicitly opts in via the in-app pre-prompt (which
-- also stamps notify_permission_prompted_at so we only ask once).
ALTER TABLE pai_user_settings
  ADD COLUMN notify_new_cards               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN notify_permission_prompted_at  TIMESTAMPTZ;
