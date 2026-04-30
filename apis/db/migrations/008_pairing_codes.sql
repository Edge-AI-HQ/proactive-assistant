-- Migration 008: pairing_codes for hardware pair-by-code flow.
-- See docs/plans/2026-04-29-personal-signal-and-pairing.mdx §三 Class B.
--
-- Why: a Web user (already logged into Supabase) needs to claim a screened
-- but unauthed device by typing a short code the device displays. Avoids
-- the device ever needing Supabase / Google login.
--
-- Lifecycle:
--   1. Device → POST /devices/pair-code/request → row inserted with
--      status='pending', user_id NULL, expires_at = now()+5min.
--   2. Device polls /devices/pair-code/poll?code=... every 3s.
--   3. User → POST /devices/pair-code/claim with the code → row updated:
--      user_id set, device_id generated, status='claimed'. user_devices
--      row created in the same transaction with the resulting device_token.
--   4. Device's next poll reads status='claimed' and pulls the token.
--   5. Sweep job marks expired rows (status='pending' AND expires_at < now())
--      so claim attempts on stale codes fail cleanly.

CREATE TABLE IF NOT EXISTS pairing_codes (
  -- 6-character user-typeable code from the unambiguous alphabet
  -- 23456789ABCDEFGHJKLMNPQRSTUVWXYZ (no 0/O/1/I/L). PRIMARY KEY also
  -- gives us a fast lookup index for free.
  code         TEXT PRIMARY KEY,

  -- 'pending' (waiting for claim) | 'claimed' (token issued, do not reuse)
  -- | 'expired' (timed out, do not claim) | 'cancelled' (device gave up)
  status       TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'expired', 'cancelled')),

  -- What kind of device this is, copied verbatim into user_devices.platform
  -- on claim. Defaults to 'wearable' if device didn't say.
  device_class TEXT NOT NULL,

  -- Optional model label the device self-reported (e.g. "omi_pendant_v1").
  model        TEXT,

  -- The user who claimed this code. NULL while pending.
  user_id      BIGINT REFERENCES users(id) ON DELETE CASCADE,

  -- The device_id that got created on claim. NULL while pending.
  -- Used so the device's poll response can return the right pointer.
  device_id    TEXT,

  -- Plaintext device_token, populated at claim time, fetched once by the
  -- device on its first post-claim poll, then NULLed. This is the only
  -- moment we store a plaintext token anywhere — bcrypt hash lives on
  -- user_devices and is the durable secret. The 5-minute pairing window
  -- is the natural TTL: if the device never picks it up, it gets swept
  -- with the row.
  device_token_temp TEXT,

  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at   TIMESTAMPTZ
);

-- Sweep job filters by (status='pending' AND expires_at < now()), so a
-- partial index keeps that scan small even with a long history.
CREATE INDEX IF NOT EXISTS idx_pairing_codes_pending_expiry
  ON pairing_codes (expires_at) WHERE status = 'pending';

-- Per-user "max 1 active code" check needs this filter cheap.
CREATE INDEX IF NOT EXISTS idx_pairing_codes_user
  ON pairing_codes (user_id) WHERE status = 'pending';

ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_pairing_codes ON pairing_codes;
CREATE POLICY service_role_pairing_codes
  ON pairing_codes
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
