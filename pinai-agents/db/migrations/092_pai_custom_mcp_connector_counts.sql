-- Bring early dev installs of pai_custom_mcp_connectors up to the schema
-- expected by the custom MCP UI/service.
--
-- 091 was applied to dev while this feature was still changing. Yoyo will not
-- replay an already-applied migration, so keep this as an additive repair.

ALTER TABLE pai_custom_mcp_connectors
  ADD COLUMN IF NOT EXISTS last_fetched_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_raw_inserted_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_evolve_task_id TEXT;
