-- Reactivate enabled recurring auto schedules that were archived by transient
-- runtime failures before recurring-task failure handling kept schedules active.

INSERT INTO pai_scheduled_tasks
  (user_id, id, kind, name, trigger_kind, interval_seconds, payload,
   timezone, status, next_run_at, attempts, last_error, last_run_status)
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
  NOW() + make_interval(secs => s.auto_generate_interval_minutes * 60),
  0,
  NULL,
  NULL
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
  attempts = 0,
  last_error = NULL,
  last_run_status = CASE
    WHEN pai_scheduled_tasks.last_run_status = 'success' THEN 'success'
    ELSE NULL
  END,
  updated_at = NOW();

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
   timezone, status, next_run_at, attempts, last_error, last_run_status)
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
  next_run_at,
  0,
  NULL,
  NULL
FROM next_fire
ON CONFLICT (user_id, id) DO UPDATE SET
  kind = EXCLUDED.kind,
  name = EXCLUDED.name,
  trigger_kind = EXCLUDED.trigger_kind,
  cron_expr = EXCLUDED.cron_expr,
  payload = EXCLUDED.payload,
  timezone = EXCLUDED.timezone,
  status = EXCLUDED.status,
  next_run_at = CASE
    WHEN pai_scheduled_tasks.status = 'active'
     AND pai_scheduled_tasks.next_run_at IS NOT NULL
    THEN pai_scheduled_tasks.next_run_at
    ELSE EXCLUDED.next_run_at
  END,
  attempts = 0,
  last_error = NULL,
  last_run_status = CASE
    WHEN pai_scheduled_tasks.last_run_status = 'success' THEN 'success'
    ELSE NULL
  END,
  updated_at = NOW();
