-- Drop pai_intent_card_state + pai_intent_thread_state.
--
-- Both were 1:1 imports from the retired OpenClaw plugin's proactive.db
-- (see migration 014's header). No runtime code ever read or wrote them
-- on the pinai-agents side — their role was fully subsumed by
-- pai_card_evaluations + pai_feedback_events + the reward dashboard
-- flow. Migration 035's backfill DO block referenced pai_intent_card_state
-- to resolve card-thread ownership, but for fresh databases the
-- langgraph.checkpoints table doesn't exist so the JOIN is skipped, and
-- for existing DBs that block already ran with these tables empty.
--
-- Pre-launch, no users, no data migration. Postgres auto-drops the
-- attached RLS policies created in 023 when the table is dropped.

DROP TABLE IF EXISTS pai_intent_card_state;
DROP TABLE IF EXISTS pai_intent_thread_state;
