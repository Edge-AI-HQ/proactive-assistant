-- Persistent per-connected-account display label.
--
-- Why a table (not just lazy-resolved in list_connections):
--   * Composio doesn't populate identity on the connected_account object —
--     each toolkit needs its own action call (GMAIL_GET_PROFILE etc.) and
--     those calls can fail/timeout/rate-limit. The UI was previously
--     re-calling them on every page open with a 24h in-memory cache, which
--     drops on every restart and produces "Account details unavailable"
--     gaps for the LLM-driven account-picker UX.
--   * Multi-account support (multiple Gmail per user) makes a stable +
--     unique label per (user, connected_account_id) load-bearing, not
--     decorative. We resolve once at OAuth-completion time and persist;
--     list_connections then joins this table at ~0 latency.
--   * Failed resolves are tracked (attempts / last error) so list_connections
--     can lazy-retry with a backoff budget instead of silently falling back
--     to "toolkit #N" forever.
--
-- Lifecycle:
--   * Row inserted by /api/composio/wait on first ACTIVE transition.
--   * Updated on /api/composio/reconnect (raw_user_info may change).
--   * Deleted by /api/composio/disconnect.

CREATE TABLE pai_connector_labels (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connected_account_id TEXT NOT NULL,
  toolkit              TEXT NOT NULL,
  label                TEXT,
  raw_user_info        JSONB,
  resolved_at          TIMESTAMPTZ,
  resolve_attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at      TIMESTAMPTZ,
  last_attempt_error   TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, connected_account_id)
);

CREATE INDEX idx_pai_connector_labels_user_toolkit
  ON pai_connector_labels (user_id, toolkit);

-- RLS — same pattern as 023.
ALTER TABLE pai_connector_labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_connector_labels_user_scope ON pai_connector_labels
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_connector_labels_service_role ON pai_connector_labels
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
