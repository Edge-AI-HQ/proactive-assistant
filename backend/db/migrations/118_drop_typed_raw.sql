-- WP6 L0 contract: retire the per-source typed raw tables + the interim generic
-- pai_raw_events store. Every source now lands in the unified `pai_raw` table
-- (toolkit + entity_type discriminator); writes cut over to pai_raw at migration
-- 110, so the typed tables (016-019) and pai_raw_events (090) only hold pre-110
-- historical rows.
--
-- This is the contract step of an expand-contract — DROP, the deliberate
-- exception to the additive-only norm, is user-authorized. The data migration
-- runs FIRST, is idempotent (ON CONFLICT DO NOTHING against pai_raw's
-- (user_id, toolkit, entity_type, dedupe_key) unique index), and precedes every
-- DROP. Historical rows are a best-effort archive: the full typed row is folded
-- into pai_raw.payload (minus the shared envelope columns); title/snippet stay
-- NULL (the recipe-projected envelope only exists for post-110 rows — payload
-- holds the complete data), external_id carries device_id for device sources.

-- ── 9 typed Composio tables → pai_raw ───────────────────────────────────
-- toolkit = the Composio slug (gcal path alias → googlecalendar); entity_type =
-- the source's entity. payload = the typed row minus the columns that map to
-- pai_raw's own envelope/provenance columns.

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'gmail', 'messages', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_gmail_messages t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'googlecalendar', 'events', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_gcal_events t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'googledrive', 'files', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_gdrive_files t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'slack', 'messages', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_slack_messages t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'github', 'issues', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_github_issues t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'calendly', 'events', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_calendly_events t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'stripe', 'invoices', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_stripe_invoices t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'youtube', 'subscriptions', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_youtube_subscriptions t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'linkedin', 'profile', NULL, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_linkedin_profile t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

-- ── 3 device typed tables → pai_raw (external_id = device_id) ────────────

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'device', 'apps', device_id, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_device_apps_snapshot t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'device', 'contacts', device_id, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_device_contacts_snapshot t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, payload, dedupe_key, reference_count,
                     last_referenced_at, referenced_by_runs)
SELECT user_id, id, 'device', 'health', device_id, occurred_at, ingested_at,
       to_jsonb(t) - 'user_id' - 'id' - 'occurred_at' - 'ingested_at'
         - 'dedupe_key' - 'reference_count' - 'last_referenced_at' - 'referenced_by_runs',
       dedupe_key, reference_count, last_referenced_at, referenced_by_runs
FROM pai_raw_device_health_observations t
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

-- ── generic pai_raw_events (090) → pai_raw (envelope columns copy through) ─

INSERT INTO pai_raw (user_id, id, toolkit, entity_type, external_id, occurred_at,
                     ingested_at, title, snippet, payload, dedupe_key,
                     reference_count, last_referenced_at, referenced_by_runs)
SELECT user_id, id, toolkit, entity_type, external_id, occurred_at, ingested_at,
       title, snippet, payload, dedupe_key, reference_count, last_referenced_at,
       referenced_by_runs
FROM pai_raw_events
ON CONFLICT (user_id, toolkit, entity_type, dedupe_key) DO NOTHING;

-- ── Drop the retired tables ─────────────────────────────────────────────
DROP TABLE IF EXISTS pai_raw_gmail_messages CASCADE;
DROP TABLE IF EXISTS pai_raw_gcal_events CASCADE;
DROP TABLE IF EXISTS pai_raw_gdrive_files CASCADE;
DROP TABLE IF EXISTS pai_raw_slack_messages CASCADE;
DROP TABLE IF EXISTS pai_raw_github_issues CASCADE;
DROP TABLE IF EXISTS pai_raw_calendly_events CASCADE;
DROP TABLE IF EXISTS pai_raw_stripe_invoices CASCADE;
DROP TABLE IF EXISTS pai_raw_youtube_subscriptions CASCADE;
DROP TABLE IF EXISTS pai_raw_linkedin_profile CASCADE;
DROP TABLE IF EXISTS pai_raw_device_apps_snapshot CASCADE;
DROP TABLE IF EXISTS pai_raw_device_contacts_snapshot CASCADE;
DROP TABLE IF EXISTS pai_raw_device_health_observations CASCADE;
DROP TABLE IF EXISTS pai_raw_events CASCADE;
