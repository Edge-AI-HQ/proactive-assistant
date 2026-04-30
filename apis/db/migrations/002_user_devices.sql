-- Migration 002: user_devices registry for multi-device routing.
-- See docs/memory-architecture.md §三 (APIs user_devices 表) and §五 (decision 6).
--
-- Why: mobile_proxy originally fell back to getDefaultMobileSyncContainer()
-- when a request didn't carry device credentials, which routed the upload
-- to "the most active container" — wrong as soon as more than one user is
-- live. This migration introduces device-scoped credentials so the proxy
-- can route by ownership instead. The token is created at device
-- registration time and returned to the client ONCE; only its bcrypt hash
-- is stored here.
--
-- 2026-04 follow-up: the default-container fallback and the legacy
-- /api/mobile/* alias have been removed. X-Device-Id + X-Device-Token are
-- now mandatory on POST /api/proactive/devices/ingest; there is no
-- anonymous path. user_devices is the only routing source.
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
