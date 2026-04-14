-- Drop legacy proactive_* tables that are no longer referenced by any code.
-- These were early-stage tables superseded by runtime_instances, users, etc.

BEGIN;

-- Drop children first in case of foreign key constraints
DROP TABLE IF EXISTS proactive_containers;
DROP TABLE IF EXISTS proactive_litellm_keys;
DROP TABLE IF EXISTS proactive_users;

COMMIT;
