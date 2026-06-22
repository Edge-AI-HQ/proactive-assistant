-- Per-run JWT revocation list. The jti claim on each agent run JWT is a
-- random uuid; if a token leaks (sandbox compromise, browser tab hijack,
-- support-tool stolen credential), web inserts the jti here and every
-- subsequent verify rejects.
--
-- TTL: rows live until the JWT they revoke would have expired anyway.
-- A nightly sweep prunes; verify-side checks `expires_at > now()` so even
-- without the sweep, a stale entry is harmless (the underlying JWT is
-- already exp-rejected by then).
--
-- Row count is small in steady state (revocations are rare incidents),
-- so a plain B-tree primary key is fine.

CREATE TABLE pai_jti_revocations (
  jti           TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT,
  revoked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

-- Sweep target: rows where the underlying JWT has already expired anyway.
CREATE INDEX idx_pai_jti_revocations_expires
  ON pai_jti_revocations (expires_at);

-- Audit lookup: find all revocations for a user (e.g. "did we revoke
-- this user's session after the support ticket").
CREATE INDEX idx_pai_jti_revocations_user_revoked
  ON pai_jti_revocations (user_id, revoked_at DESC);

-- RLS: service-role-only. Verify path runs as service_role inside web
-- (no app.user_id binding for the cross-user check). UI doesn't read
-- this table directly.
ALTER TABLE pai_jti_revocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_jti_revocations_service_only ON pai_jti_revocations
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
