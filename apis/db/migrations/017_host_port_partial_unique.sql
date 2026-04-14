-- Migration 017: Allow NULL host_port + partial unique index
--
-- The original idx_runtime_host_port_unique was an unconditional unique index,
-- which breaks when multiple containers legitimately have no assigned port
-- (host_port IS NULL). Proactive-ai containers don't use host_port at all.
--
-- 1. Drop NOT NULL constraint on host_port (proactive containers have no port)
-- 2. Replace with a partial unique index that only enforces uniqueness for
--    non-NULL values.

ALTER TABLE runtime_instances ALTER COLUMN host_port DROP NOT NULL;
ALTER TABLE runtime_instances ALTER COLUMN host_port SET DEFAULT NULL;

DROP INDEX IF EXISTS idx_runtime_host_port_unique;

CREATE UNIQUE INDEX idx_runtime_host_port_unique
  ON runtime_instances(host_port)
  WHERE host_port IS NOT NULL;
