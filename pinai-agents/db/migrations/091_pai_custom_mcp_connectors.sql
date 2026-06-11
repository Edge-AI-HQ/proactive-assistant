-- User-defined Remote MCP connectors.
--
-- The connector metadata lives here; pulled MCP server/tool/resource
-- descriptors land in pai_raw_events so the existing agent raw reader and
-- generation context can use them without a separate storage path.

CREATE TABLE pai_custom_mcp_connectors (
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id               TEXT   NOT NULL,
  slug             TEXT   NOT NULL,
  name             TEXT   NOT NULL,
  server_url       TEXT   NOT NULL,
  status           TEXT   NOT NULL DEFAULT 'ACTIVE',
  last_fetched_count INTEGER NOT NULL DEFAULT 0,
  last_raw_inserted_count INTEGER NOT NULL DEFAULT 0,
  last_evolve_task_id TEXT,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, slug),
  UNIQUE (user_id, server_url)
);

CREATE INDEX idx_pai_custom_mcp_connectors_user_status
  ON pai_custom_mcp_connectors (user_id, status);

ALTER TABLE pai_custom_mcp_connectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY pai_custom_mcp_connectors_user_scope ON pai_custom_mcp_connectors
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);

CREATE POLICY pai_custom_mcp_connectors_service_role ON pai_custom_mcp_connectors
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
