CREATE TABLE pai_onboarding_connector_summary_runs (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  toolkit               TEXT NOT NULL,
  connected_account_id  TEXT,
  model_id              TEXT NOT NULL,
  item_count            INTEGER NOT NULL DEFAULT 0,
  collect_ms            INTEGER NOT NULL DEFAULT 0,
  llm_ms                INTEGER,
  total_ms              INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL
                        CHECK (status IN ('empty', 'cached', 'succeeded', 'failed')),
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pai_onboarding_summary_runs_user_created
  ON pai_onboarding_connector_summary_runs (user_id, created_at DESC);
CREATE INDEX idx_pai_onboarding_summary_runs_toolkit_created
  ON pai_onboarding_connector_summary_runs (toolkit, created_at DESC);
CREATE INDEX idx_pai_onboarding_summary_runs_status_created
  ON pai_onboarding_connector_summary_runs (status, created_at DESC);

CREATE TABLE pai_onboarding_connector_summary_cache (
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key             TEXT NOT NULL,
  toolkit               TEXT NOT NULL,
  connected_account_id  TEXT,
  model_id              TEXT NOT NULL,
  raw_fingerprint       TEXT NOT NULL,
  item_count            INTEGER NOT NULL DEFAULT 0,
  summary               JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at          TIMESTAMPTZ,
  use_count             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, cache_key)
);

CREATE INDEX idx_pai_onboarding_summary_cache_user_updated
  ON pai_onboarding_connector_summary_cache (user_id, updated_at DESC);

ALTER TABLE pai_onboarding_connector_summary_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_onboarding_connector_summary_runs_user_scope
  ON pai_onboarding_connector_summary_runs
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_onboarding_connector_summary_runs_service_role
  ON pai_onboarding_connector_summary_runs
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

ALTER TABLE pai_onboarding_connector_summary_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_onboarding_connector_summary_cache_user_scope
  ON pai_onboarding_connector_summary_cache
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_onboarding_connector_summary_cache_service_role
  ON pai_onboarding_connector_summary_cache
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
