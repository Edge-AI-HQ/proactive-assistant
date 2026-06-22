-- Clear stale failure bookkeeping for active recurring tasks whose latest
-- recorded fire already succeeded. Future successes are handled in code by
-- record_recurring_success().

WITH latest_runs AS (
  SELECT DISTINCT ON (user_id, task_id)
    user_id,
    task_id,
    status
  FROM pai_scheduled_task_runs
  ORDER BY user_id, task_id, fired_at DESC
)
UPDATE pai_scheduled_tasks st
SET attempts = 0,
    last_run_status = 'success',
    last_error = NULL,
    updated_at = NOW()
FROM latest_runs lr
WHERE st.user_id = lr.user_id
  AND st.id = lr.task_id
  AND st.trigger_kind <> 'once'
  AND st.status = 'active'
  AND lr.status = 'success'
  AND (
    st.attempts <> 0
    OR st.last_error IS NOT NULL
    OR st.last_run_status IS DISTINCT FROM 'success'
  );
