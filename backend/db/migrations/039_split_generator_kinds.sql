-- Split kind='generator' into namespaced siblings, mirroring the rest of
-- the codebase (`auto.dreaming`, `connector.init|sync|evolve`, etc.). The
-- old single kind silently bundled two distinct lifecycles — a once-shot
-- manual click vs. a recurring schedule — and forced every consumer to
-- discriminate by trigger_kind in a second pass. Promoting the split to
-- the kind name itself makes every WHERE / dispatch site self-explaining
-- and removes a class of "kind=generator was always once" assumption
-- bugs (see commits 75eb4cb3, c64531cc).
--
-- Idempotent on a fresh DB (no rows match) and idempotent on re-runs
-- (after the first run, kind values are 'generator.manual' / 'generator.auto'
-- so the predicates exclude them).
UPDATE pai_scheduled_tasks
   SET kind = 'generator.manual'
 WHERE kind = 'generator' AND trigger_kind = 'once';

UPDATE pai_scheduled_tasks
   SET kind = 'generator.auto'
 WHERE kind = 'generator' AND trigger_kind = 'schedule';
