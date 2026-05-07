-- Multi-device registry. 1:1 from apis user_devices (002 + 007 + 009).
-- Owns the device-token lifecycle: bcrypt hash, fingerprint dedupe, status.
--
-- Auth flow:
--   1. Client POSTs /api/devices/register with deviceId + platform (Supabase JWT).
--   2. Server bcrypt-hashes a fresh 256-bit token, stores hash, returns plaintext once.
--   3. Subsequent /api/devices/ingest sends X-Device-Id + X-Device-Token.
--      Verified via bcrypt compare; user_id resolved from this row.
--
-- Fingerprint dedupe: when a fresh app install produces a new deviceId but the
-- physical device is the same (sha256(platform + hardwareFingerprint)), we
-- rotate the existing row instead of stranding the old one as a phantom.

CREATE TABLE pai_user_devices (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id                TEXT NOT NULL,
  device_token_hash        TEXT NOT NULL,
  platform                 TEXT NOT NULL
                           CHECK (platform IN ('ios', 'android', 'web', 'wearable', 'sensor', 'embedded')),
  display_name             TEXT,
  app_version              TEXT,
  model                    TEXT,
  device_fingerprint_hash  TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'revoked')),
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  registered_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at             TIMESTAMPTZ,
  UNIQUE (device_id)
);

CREATE INDEX idx_pai_user_devices_user_status
  ON pai_user_devices (user_id, status);

CREATE INDEX idx_pai_user_devices_fingerprint
  ON pai_user_devices (user_id, platform, device_fingerprint_hash)
  WHERE device_fingerprint_hash IS NOT NULL;

-- RLS: per-user row scope, with service_role fallback for the device-token
-- lookup path (ingest verifies the token *before* user_id is known, so
-- that one query needs to run as service_role with app.user_id unset).
ALTER TABLE pai_user_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_user_devices_user_scope ON pai_user_devices
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_user_devices_service_role ON pai_user_devices
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
