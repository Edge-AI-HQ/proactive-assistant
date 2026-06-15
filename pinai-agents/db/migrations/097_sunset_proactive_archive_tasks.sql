-- Proactive sunset (PR1): stop all system-initiated scheduled work.
--
-- The proactive.tick heartbeat handler and the auto-generate schedule mirror
-- (_sync_auto_generate_schedule) are both removed in code. Archive existing
-- rows so the tick loop stops claiming them:
--   * proactive.tick — the dispatcher handler is gone, so an active row would
--     log "unknown task.kind" every tick.
--   * generator.auto — the dispatcher handler still exists (shared with
--     manual/chat/scheduled), so a stale active row would KEEP firing automatic
--     card generation. Archiving is what actually turns auto-generate off.
-- Manual / chat / scheduled generation, reminder.card and auto.dreaming are
-- untouched.
UPDATE pai_scheduled_tasks
SET status = 'archived', next_run_at = NULL, updated_at = NOW()
WHERE kind IN ('proactive.tick', 'generator.auto')
  AND status <> 'archived';
