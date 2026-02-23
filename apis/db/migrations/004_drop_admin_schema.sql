-- Remove legacy admin schema and session tables.

BEGIN;

DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS admin_users;

COMMIT;
