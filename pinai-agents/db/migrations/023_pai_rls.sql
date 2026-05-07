-- RLS — defense-in-depth for multi-tenant isolation.
--
-- Every per-user pai_* table:
--   * ENABLE ROW LEVEL SECURITY
--   * Main policy: row visible iff user_id = current_setting('app.user_id')::bigint
--   * Fallback policy: row visible to service_role when app.user_id is unset
--     (operations, migrations, scheduler tick — these legitimately need
--     cross-user access)
--
-- Repository code wraps every request in:
--   BEGIN; SET LOCAL app.user_id = $user_id; <queries>; COMMIT;
-- so the main policy fires per-request. If application code somehow forgets
-- the SET LOCAL, the fallback only triggers from service_role connections,
-- not from per-user contexts — RLS becomes the second wall.
--
-- Two non-tenant tables are exceptions:
--   * pai_world_signals — globally shared, no RLS (read-anywhere by design)
--   * pai_yoyo_migration_log — yoyo's own state, RLS would break apply

-- service_role is a Supabase built-in but missing in vanilla local Postgres.
-- Create it idempotently here so the RLS policies can reference it on both
-- targets (Supabase prod + dev compose). NOLOGIN — service_role is used via
-- SET ROLE, not direct connection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END$$;

-- Helper to apply the standard policy pair to a per-user table.
-- Inlined per-table for clarity rather than as a function (forward-only
-- migrations should produce diff-readable SQL).

DO $$
DECLARE
  t TEXT;
  per_user_tables TEXT[] := ARRAY[
    -- 010
    'pai_profile', 'pai_goals', 'pai_user_settings', 'pai_app_state',
    -- 011
    'pai_memory', 'pai_personal_signals', 'pai_feedback_events',
    -- 012
    'pai_skill_index',
    -- 013
    'pai_evolution_runs',
    -- 014
    'pai_pipeline_runs', 'pai_card_evaluations',
    'pai_intent_card_state', 'pai_intent_thread_state',
    -- 015
    'pai_background_tasks', 'pai_background_task_schedules',
    'pai_task_attempts', 'pai_connector_sync_cursors',
    -- 016
    'pai_raw_gmail_messages', 'pai_raw_gcal_events',
    'pai_raw_gdrive_files', 'pai_raw_gdocs_documents',
    'pai_raw_gsheets_spreadsheets', 'pai_raw_outlook_messages',
    -- 017
    'pai_raw_slack_messages', 'pai_raw_notion_pages',
    'pai_raw_discord_guilds', 'pai_raw_github_issues',
    'pai_raw_jira_projects', 'pai_raw_asana_workspaces',
    'pai_raw_asana_tasks', 'pai_raw_clickup_user',
    'pai_raw_clickup_workspaces', 'pai_raw_trello_boards',
    -- 018
    'pai_raw_spotify_recent_tracks', 'pai_raw_strava_activities',
    'pai_raw_todoist_tasks', 'pai_raw_youtube_subscriptions',
    'pai_raw_twitter_bookmarks', 'pai_raw_calendly_events',
    'pai_raw_linkedin_profile', 'pai_raw_linkedin_organizations',
    'pai_raw_figma_user', 'pai_raw_zoom_user',
    'pai_raw_zoom_marketplace_apps', 'pai_raw_dropbox_account',
    'pai_raw_dropbox_files', 'pai_raw_hubspot_contacts',
    'pai_raw_stripe_invoices',
    -- 019
    'pai_raw_device_apps_snapshot', 'pai_raw_device_contacts_snapshot',
    'pai_raw_device_health_observations',
    -- 020 (per-user view; world_signals proper is shared)
    'pai_world_signal_user_view',
    -- 021
    'pai_scheduled_tasks', 'pai_scheduled_task_runs',
    -- 022
    'pai_agent_audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY per_user_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    -- Main policy: per-user row scope.
    EXECUTE format($f$
      CREATE POLICY %I_user_scope ON %I
        FOR ALL TO PUBLIC
        USING (user_id = current_setting('app.user_id', true)::bigint)
        WITH CHECK (user_id = current_setting('app.user_id', true)::bigint)
    $f$, t, t);

    -- Fallback: service_role catch-all when app.user_id is unset.
    -- Used by ops / migrations / scheduler dispatcher bootstrapping.
    EXECUTE format($f$
      CREATE POLICY %I_service_role ON %I
        FOR ALL TO service_role
        USING (current_setting('app.user_id', true) IS NULL
            OR current_setting('app.user_id', true) = '')
        WITH CHECK (current_setting('app.user_id', true) IS NULL
                 OR current_setting('app.user_id', true) = '')
    $f$, t, t);
  END LOOP;
END$$;

-- pai_world_signals (shared) — RLS off so any user can SELECT, but writes
-- restricted to service_role at the GRANT level (handled by 024 pai_chat
-- role split). For now public read is open; write happens only via web
-- process which always uses service_role.
ALTER TABLE pai_world_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_world_signals_public_read ON pai_world_signals
  FOR SELECT TO PUBLIC USING (TRUE);
CREATE POLICY pai_world_signals_service_write ON pai_world_signals
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
