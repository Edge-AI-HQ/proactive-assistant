-- Drop pai_app_state.
--
-- The table was a generic per-user KV (namespace, key, value) added in
-- 010 with /api/agent/state as the planned interface (crystallize state,
-- agent scratch state, custom UI prefs). No caller ever materialized:
-- pinai_sdk has no `state` domain, chat process never hits the route,
-- both frontends never touch it. The personal-data snapshot listed it
-- only as a tautological "export everything" placeholder.
--
-- Crystallize was implemented entirely via LangGraph state in
-- chat/agents/crystallize.py — no KV needed.
--
-- The /api/agent/state route, the AppStateRepository, and the
-- snapshot's app_state branch are removed alongside this migration.
-- Postgres auto-drops the RLS policies created in 023.

DROP TABLE IF EXISTS pai_app_state;
