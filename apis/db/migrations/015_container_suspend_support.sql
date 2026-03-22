-- Add 'suspended' to runtime_instances status CHECK constraint
-- Add last_active_at column for DB-based idle suspend tracking

-- 1. Drop and recreate the CHECK constraint to include 'suspended'
ALTER TABLE runtime_instances
  DROP CONSTRAINT IF EXISTS runtime_instances_status_check;

ALTER TABLE runtime_instances
  ADD CONSTRAINT runtime_instances_status_check
  CHECK (status IN ('creating', 'running', 'stopped', 'suspended', 'error', 'idle', 'missing'));

-- 2. Add last_active_at column (nullable; NULL means no outbound activity recorded yet)
ALTER TABLE runtime_instances
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- 3. Backfill existing rows so they are eligible for idle-suspend from now
UPDATE runtime_instances SET last_active_at = NOW() WHERE last_active_at IS NULL;

-- 4. Index for periodic idle scan: find running containers with stale last_active_at
CREATE INDEX IF NOT EXISTS idx_runtime_instances_idle_scan
  ON runtime_instances(status, last_active_at)
  WHERE status = 'running' AND last_active_at IS NOT NULL;
