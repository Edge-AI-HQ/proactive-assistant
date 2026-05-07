-- Per-sandbox phantom tokens.
--
-- Industry pattern (Anthropic Claude Code, E2B egressTransform, broker /
-- "phantom token" architecture): the real per-user credential
-- (LiteLLM virtual_key, signing JWT) NEVER enters the sandbox. The
-- sandbox holds only an opaque random token; web resolves it server-side
-- to the user's identity and forwards the call with the real credentials.
--
-- This sits next to pai_jti_revocations (028) but serves a different
-- credential family:
--   * pai_jti_revocations  — JWTs (chat-driving, signed by web, EdDSA)
--   * pai_sandbox_phantom_tokens — opaque random tokens (sandbox-side
--     bearer for /api/agent/* calls)
--
-- Storage: token_hash only (SHA-256 of the raw token). Even a full DB
-- dump cannot reconstruct the bearer values. Standard password-hash
-- pattern adapted for opaque API tokens.
--
-- Revocation: soft (revoked_at timestamp). Allows audit: "when did we
-- kill this sandbox's access". Sweep cron drops rows past the natural
-- TTL (sandbox auto_delete = 24h, so a 7-day retention covers postmortem
-- forensics and then prunes).

CREATE TABLE pai_sandbox_phantom_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Free-form chat/run correlation id (e.g. session_key for chat threads,
  -- "gen-<run_id>" for one-shot generators, "oneshot-<uuid>" for
  -- python_exec without session). Used only for audit / log join, not
  -- for auth — the auth decision keys off token_hash alone.
  scope_label   TEXT,
  -- The Daytona sandbox id this token was minted for. Nullable because
  -- some callers mint before the sandbox exists (Daytona env vars are
  -- fixed at create time, so token must precede sandbox); UPDATE binds
  -- it after Daytona returns the id.
  sandbox_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- expires_at = created_at + sandbox auto_delete TTL. Resolve rejects
  -- past-exp rows even if revoked_at is NULL — defense in depth against
  -- orphaned rows (mint succeeded, sandbox creation failed, no revoke).
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT
);

-- Hot path: every /api/agent/* call from a sandbox does
--   SELECT user_id FROM pai_sandbox_phantom_tokens
--   WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()
-- token_hash is already PK so no extra index needed.

-- Audit / revoke-by-sandbox: chat layer revokes by Daytona sandbox id
-- when evicting. Partial index keeps it small (most rows are unrevoked).
CREATE INDEX idx_pai_sandbox_phantom_active_by_sandbox
  ON pai_sandbox_phantom_tokens (sandbox_id)
  WHERE revoked_at IS NULL;

-- Sweep target: drop rows whose TTL elapsed >7d ago.
CREATE INDEX idx_pai_sandbox_phantom_expires
  ON pai_sandbox_phantom_tokens (expires_at);

-- RLS: service-role only. Mirrors pai_jti_revocations — verify path runs
-- before user_id is trusted, and chat-side revoke goes through web's
-- service_tx anyway. No UI surface reads these.
ALTER TABLE pai_sandbox_phantom_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_sandbox_phantom_tokens_service_only
  ON pai_sandbox_phantom_tokens
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
