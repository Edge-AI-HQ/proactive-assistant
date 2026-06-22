-- Per-user record of websites the user has logged into through the agent's
-- browser (Browserbase live view). METADATA ONLY — no cookies/credentials
-- are stored here. The actual login state (cookies / localStorage) lives in
-- the user's persistent Browserbase Context (users.browserbase_context_id)
-- with persist:True. This table only tracks WHICH sites have login state, so
-- the UI can list them and the user can delete a site's cookies.
--
-- Why a table: the Browserbase Context is an opaque blob — there's no API to
-- enumerate "which domains have cookies in it". We record the sites ourselves
-- (on user-driven live-view login) to power the data-connector list + delete.
--
-- Lifecycle:
--   * Upserted (status=active) by POST /api/browser/logins when the user
--     manually operates the live view on a site (user-control mode).
--   * Deleted by DELETE /api/browser/logins/{site_domain}, which also clears
--     that origin's cookies from the Context via chat CDP.
--   * status='expired' is reserved for future login-wall detection (P1).

CREATE TABLE pai_browser_logins (
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_domain   TEXT NOT NULL,
  display_name  TEXT,
  login_label   TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, site_domain)
);

CREATE INDEX idx_pai_browser_logins_user_used
  ON pai_browser_logins (user_id, last_used_at DESC);

-- RLS — same pattern as 023 / 040.
ALTER TABLE pai_browser_logins ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_browser_logins_user_scope ON pai_browser_logins
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_browser_logins_service_role ON pai_browser_logins
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
