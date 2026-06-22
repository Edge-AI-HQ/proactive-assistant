-- Reactivate generator.auto scheduler rows for users whose settings
-- switch is ON.
--
-- Failed recurring tasks can become archived after max_attempts. When
-- pai_user_settings.auto_generate remains TRUE, the schedule should be
-- active again after the failing runtime condition is fixed.
INSERT INTO pai_scheduled_tasks
  (user_id, id, kind, name, trigger_kind, interval_seconds, payload,
   timezone, status, next_run_at)
SELECT
  s.user_id,
  'gen.auto.' || s.user_id::text,
  'generator.auto',
  NULL,
  'schedule',
  s.auto_generate_interval_minutes * 60,
  jsonb_build_object(
    'cards_to_generate', 4,
    'output_language', s.generation_language,
    'trigger', 'auto'
  ),
  'UTC',
  'active',
  NOW() + make_interval(secs => s.auto_generate_interval_minutes * 60)
FROM pai_user_settings s
WHERE s.auto_generate = TRUE
ON CONFLICT (user_id, id) DO UPDATE SET
  kind = EXCLUDED.kind,
  name = EXCLUDED.name,
  trigger_kind = EXCLUDED.trigger_kind,
  interval_seconds = EXCLUDED.interval_seconds,
  payload = EXCLUDED.payload,
  timezone = EXCLUDED.timezone,
  status = EXCLUDED.status,
  next_run_at = CASE
    WHEN pai_scheduled_tasks.status = 'active'
     AND pai_scheduled_tasks.next_run_at IS NOT NULL
    THEN pai_scheduled_tasks.next_run_at
    ELSE EXCLUDED.next_run_at
  END,
  updated_at = NOW();
