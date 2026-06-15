-- Proactive sunset (PR5): drop the proactive-only tables now that every
-- reader/writer is gone.
--
--   * pai_timeline_events (064) — the proactive agent's event store. Its sole
--     reader (proactive agent, PR1) and writers (ambient timeline_only policy +
--     connector dual-write, PR2/PR3) are all removed.
--   * pai_proactive_state (069, extended by 074/075) — heartbeat ingestion
--     cursor. ProactiveRepository + the proactive.tick handler were removed in
--     PR1.
--   * pai_proactive_inbox (069, extended by 075/076) — the old proactive inbox
--     queue, superseded by pai_agent_messages (083); already dead in code.
--
-- DROP ... CASCADE removes each table's own indexes + RLS policies + the
-- columns added by the 074/075/076 ALTERs. No other table FKs into these
-- (verified: no `REFERENCES pai_timeline_events|pai_proactive_*` in any
-- migration), so CASCADE has nothing external to touch. IF EXISTS keeps the
-- migration idempotent across environments where a table may already be gone.
--
-- NOT dropped here: pai_user_settings.proactive_enabled /
-- proactive_interval_seconds and the auto_generate columns. Those are plain
-- columns still referenced by the settings repository / API model and the
-- retained frontend runtime (fetchProactiveEnabled + ConversationView toggle);
-- contracting them is a separate expand-contract that also touches that code.
DROP TABLE IF EXISTS pai_timeline_events CASCADE;
DROP TABLE IF EXISTS pai_proactive_state CASCADE;
DROP TABLE IF EXISTS pai_proactive_inbox CASCADE;
