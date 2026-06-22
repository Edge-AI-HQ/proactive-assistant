-- pai_reward DB role — scoped least-privilege role for the reward-dashboard
-- service (pinai_reward_dashboard), the internal card-review backend.
--
-- Part of the fly three-app split (deploy/fly-split/, backend-rearchitecture
-- §四/§十二). The reward-dashboard app holds NO master credentials and connects
-- with THIS role's DSN (REWARD_DATABASE_URL) instead of the superuser
-- DATABASE_URL, so a compromise of the internal review tool cannot touch tables
-- outside its grant set, nor any master-credential-backed action.
--
-- READY BUT NOT ACTIVE: creating the role is harmless; nobody can connect as it
-- until an operator sets its password + REWARD_DATABASE_URL (see runbook). The
-- single agents app keeps using the superuser DATABASE_URL unchanged.
--
-- ── Grant set (derived from the service's actual SQL — verified by grep over
--    services/reward-dashboard/src/pinai_reward_dashboard/ + the two shared
--    repos it imports: pinai_db.repositories.{patterns,user_fingerprint} and
--    pinai_db.raw_sources) ──
--
--   READ (SELECT):
--     reward review  — pai_pipeline_runs, pai_card_evaluations,
--                      pai_card_reward_events, pai_card_pattern_hits,
--                      pai_card_pattern_demos, pai_feedback_events,
--                      pai_world_signals (global), pai_card_patterns
--     personal-data  — pai_profile, pai_user_settings, pai_goals, pai_memory,
--       snapshot        pai_skill_index, pai_personal_signals,
--                      pai_world_signal_user_view, pai_user_devices,
--                      pai_connector_labels, pai_connector_sync_cursors,
--                      pai_user_pattern_pref, and every pai_raw_* source table
--     users          — SELECT only (resolve reviewer's BIGINT row)
--
--   WRITE (INSERT/UPDATE/DELETE — reward owns these):
--     pai_card_casebook, pai_card_reward_events, pai_trace_artifacts,
--     pai_card_pattern_demos, pai_user_pattern_pref, pai_user_intent_pref
--
--   READ+WRITE (curate the shared pattern library):
--     pai_card_patterns (SELECT/INSERT/UPDATE/DELETE)
--
-- ── users: SELECT + UPDATE, deliberately NO INSERT ──
-- The reward service's auth path (auth.py:_upsert_user_by_supabase_id) today
-- runs `INSERT INTO users ... ON CONFLICT DO UPDATE` to first-touch the
-- reviewer row. The trust review concluded an internal read tool must NOT mint
-- `users` rows: granting INSERT would let the untrusted-surface review app
-- create identities. So this role gets SELECT (look up the reviewer) + UPDATE
-- (bump last_active_at on an existing row) but NOT INSERT. Consequence: a
-- brand-new reviewer whose `users` row was never seeded by the trusted api path
-- (or Supabase admin) will get a 401 from the dashboard rather than be
-- auto-provisioned. Reviewers must be pre-provisioned. Activation runbook flags
-- this — see deploy/fly-split/README.md.
--
-- ── RLS (023_pai_rls.sql) ──
-- This role is NOT the Postgres superuser, so unlike today's connection it does
-- NOT bypass RLS. The reward service uses two access modes (pinai_db.rls):
--   * user_scoped_tx  — sets app.user_id; the PUBLIC user-scope policy fires and
--                       per-user rows are visible. Works for any role.
--   * service_tx      — leaves app.user_id unset; only the `TO service_role`
--                       fallback policy makes rows visible. service_tx does NOT
--                       `SET ROLE service_role`, so the connecting role must
--                       itself have service_role's privileges for cross-user
--                       reads (reward review lists every user's cards) to return
--                       rows. We GRANT service_role TO pai_reward below so the
--                       fallback policy applies. This grants RLS row-visibility
--                       only — table reach is still bounded by the explicit
--                       GRANTs above (pai_reward can't touch a table it has no
--                       grant on, service_role membership notwithstanding).
-- Local docker-compose dev may not have every table yet; the per-statement
-- guards make this idempotent and safe to re-apply.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pai_reward') THEN
    -- Passwordless on creation: nobody can connect until an operator sets a
    -- password (Supabase/Fly dashboard) and puts the DSN in REWARD_DATABASE_URL.
    CREATE ROLE pai_reward LOGIN;
  END IF;
END$$;

-- pai_* and users live in `public`. The role needs schema USAGE (this is the
-- key difference from pai_chat, which is REVOKEd from public entirely). USAGE
-- alone exposes nothing — only the table GRANTs below do.
GRANT USAGE ON SCHEMA public TO pai_reward;

-- RLS row-visibility for cross-user reads via service_tx (see header). Guarded
-- because service_role is created by 023_pai_rls.sql; this migration runs after.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT service_role TO pai_reward;
  END IF;
END$$;

-- ── Per-table grants ──────────────────────────────────────────────────────
-- Each wrapped in to_regclass guards so applying against a local Postgres that
-- hasn't built a given table yet is a no-op rather than an error.

DO $$
DECLARE
  t TEXT;
  -- SELECT-only product tables (reward review reads + personal-data snapshot).
  read_tables TEXT[] := ARRAY[
    'pai_pipeline_runs', 'pai_card_evaluations', 'pai_card_reward_events',
    'pai_card_pattern_hits', 'pai_card_pattern_demos', 'pai_feedback_events',
    'pai_world_signals',
    'pai_profile', 'pai_user_settings', 'pai_goals', 'pai_memory',
    'pai_skill_index', 'pai_personal_signals', 'pai_world_signal_user_view',
    'pai_user_devices', 'pai_connector_labels', 'pai_connector_sync_cursors',
    'pai_user_pattern_pref',
    -- pai_raw_* sources read by personal_data_snapshot / raw_sources.
    'pai_raw_events',
    'pai_raw_gmail_messages', 'pai_raw_gcal_events', 'pai_raw_gdrive_files',
    'pai_raw_slack_messages', 'pai_raw_github_issues', 'pai_raw_calendly_events',
    'pai_raw_stripe_invoices', 'pai_raw_youtube_subscriptions',
    'pai_raw_linkedin_profile', 'pai_raw_device_apps_snapshot',
    'pai_raw_device_contacts_snapshot', 'pai_raw_device_health_observations'
  ];
  -- Tables reward owns / writes (insert/update/delete).
  write_tables TEXT[] := ARRAY[
    'pai_card_casebook', 'pai_card_reward_events', 'pai_trace_artifacts',
    'pai_card_pattern_demos', 'pai_user_pattern_pref', 'pai_user_intent_pref'
  ];
BEGIN
  FOREACH t IN ARRAY read_tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO pai_reward', t);
    END IF;
  END LOOP;

  FOREACH t IN ARRAY write_tables LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO pai_reward', t
      );
    END IF;
  END LOOP;

  -- pai_card_patterns: full curate (read + write + retire).
  IF to_regclass('public.pai_card_patterns') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.pai_card_patterns TO pai_reward;
  END IF;

  -- users: SELECT + UPDATE only — NO INSERT (see header trust-review note).
  IF to_regclass('public.users') IS NOT NULL THEN
    GRANT SELECT, UPDATE ON public.users TO pai_reward;
  END IF;
END$$;

-- Sequences backing the INSERT targets (serial/identity PKs). USAGE+SELECT on
-- the sequences owned by tables this role writes. Granting per-sequence by
-- ownership avoids a blanket grant over public's sequences (which would include
-- tables reward must not write).
DO $$
DECLARE
  seq TEXT;
  owned_by_writable TEXT[] := ARRAY[
    'pai_card_casebook', 'pai_card_reward_events', 'pai_trace_artifacts',
    'pai_card_pattern_demos', 'pai_user_pattern_pref', 'pai_user_intent_pref',
    'pai_card_patterns'
  ];
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY owned_by_writable LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;
    FOR seq IN
      SELECT pg_get_serial_sequence('public.' || tbl, a.attname)
      FROM pg_attribute a
      WHERE a.attrelid = ('public.' || tbl)::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND pg_get_serial_sequence('public.' || tbl, a.attname) IS NOT NULL
    LOOP
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO pai_reward', seq);
    END LOOP;
  END LOOP;
END$$;
