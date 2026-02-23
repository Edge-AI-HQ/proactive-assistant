-- Assistant-only runtime cleanup
-- User-scope runtime instances are deprecated in the unified assistant model.

BEGIN;

DELETE FROM runtime_instances
WHERE scope = 'user';

COMMIT;
