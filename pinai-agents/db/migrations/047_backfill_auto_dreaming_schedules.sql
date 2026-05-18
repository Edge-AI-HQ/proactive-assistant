-- Backfill daily auto.dreaming scheduler rows for users whose settings
-- switch is already ON.
--
-- Before this migration the /api/settings route persisted
-- pai_user_settings.auto_dreaming but did not materialize the scheduler
-- row, so enabled users never fired a daily dream.
WITH enabled_users AS (
  SELECT
    s.user_id,
    COALESCE(tz.name, 'UTC') AS timezone
  FROM pai_user_settings s
  LEFT JOIN pai_profile p ON p.user_id = s.user_id AND p.id = 'primary'
  LEFT JOIN pg_timezone_names tz ON tz.name = p.timezone
  WHERE s.auto_dreaming = TRUE
),
next_fire AS (
  SELECT
    user_id,
    timezone,
    CASE
      WHEN ((date_trunc('day', NOW() AT TIME ZONE timezone) + INTERVAL '6 hours') AT TIME ZONE timezone) > NOW()
      THEN ((date_trunc('day', NOW() AT TIME ZONE timezone) + INTERVAL '6 hours') AT TIME ZONE timezone)
      ELSE ((date_trunc('day', NOW() AT TIME ZONE timezone) + INTERVAL '1 day 6 hours') AT TIME ZONE timezone)
    END AS next_run_at
  FROM enabled_users
)
INSERT INTO pai_scheduled_tasks
  (user_id, id, kind, name, trigger_kind, cron_expr, payload,
   timezone, status, next_run_at)
SELECT
  user_id,
  'dream.auto.' || user_id::text,
  'auto.dreaming',
  'Daily auto dreaming',
  'schedule',
  '0 6 * * *',
  '{"trigger":"auto"}'::jsonb,
  timezone,
  'active',
  next_run_at
FROM next_fire
ON CONFLICT (user_id, id) DO UPDATE SET
  kind = EXCLUDED.kind,
  name = EXCLUDED.name,
  trigger_kind = EXCLUDED.trigger_kind,
  cron_expr = EXCLUDED.cron_expr,
  payload = EXCLUDED.payload,
  timezone = EXCLUDED.timezone,
  status = EXCLUDED.status,
  next_run_at = EXCLUDED.next_run_at,
  updated_at = NOW();
