-- Migration 009: stable app-scoped device fingerprint for duplicate recovery.
--
-- Native clients keep a random UUID in secure storage / Keychain. The server
-- stores only a hash of that value and uses it to recover the same logical
-- user_devices row after app reinstall or WebView storage loss.

ALTER TABLE user_devices
  ADD COLUMN IF NOT EXISTS device_fingerprint_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_devices_active_fingerprint
  ON user_devices(user_id, platform, device_fingerprint_hash)
  WHERE device_fingerprint_hash IS NOT NULL AND status = 'active';
