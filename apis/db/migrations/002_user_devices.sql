-- Migration 002: user_devices registry for multi-device routing.
-- See docs/memory-architecture.md §三 (APIs user_devices 表) and §五 (decision 6).
--
-- Why: today mobile_proxy uses getDefaultMobileSyncContainer() which routes
-- every incoming /api/mobile/* request to "the most active container". With
-- multiple users (or multiple devices per user), this is wrong. After this
-- migration, mobile uploads carry an X-Device-Id + X-Device-Token header,
-- and the proxy routes to the user that owns that device.
--
-- The token is created at device registration time and returned to the
-- client ONCE; only its bcrypt hash is stored here.

CREATE TABLE IF NOT EXISTS user_devices (
  id                 BIGSERIAL PRIMARY KEY,
  device_id          TEXT NOT NULL,                    -- client-generated UUID v4
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_token_hash  TEXT NOT NULL,                    -- bcrypt(token); plaintext returned once
  platform           TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  display_name       TEXT,                              -- "iPhone 15 / smile"
  app_version        TEXT,
  registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'revoked')),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user
  ON user_devices(user_id, status);

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_user_devices ON user_devices;
CREATE POLICY service_role_user_devices
  ON user_devices
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
