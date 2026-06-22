-- Drop pai_raw_* tables for toolkits not in the 11-toolkit first-batch
-- scope (see docs/plans/2026-05-07-composio-architecture-redesign.mdx).
--
-- Kept (10 Composio + 3 device):
--   gmail_messages, gcal_events, gdrive_files, github_issues,
--   slack_messages, calendly_events, stripe_invoices,
--   youtube_subscriptions, twitter_bookmarks, linkedin_profile,
--   device_apps_snapshot, device_contacts_snapshot, device_health_observations
--
-- Discord is in the 11 toolkits but flagged connect_only (no ingest action
-- meaningful per Composio's API surface), so its raw table is dropped too.
-- linkedin_organizations is dropped because the LinkedIn recipe only uses
-- LINKEDIN_GET_MY_INFO → linkedin_profile; org info is a deferred 备选.
--
-- Pre-launch product, no users, no data migration needed.

DROP TABLE IF EXISTS pai_raw_gdocs_documents;
DROP TABLE IF EXISTS pai_raw_gsheets_spreadsheets;
DROP TABLE IF EXISTS pai_raw_outlook_messages;

DROP TABLE IF EXISTS pai_raw_notion_pages;
DROP TABLE IF EXISTS pai_raw_jira_projects;
DROP TABLE IF EXISTS pai_raw_asana_tasks;
DROP TABLE IF EXISTS pai_raw_asana_workspaces;
DROP TABLE IF EXISTS pai_raw_clickup_workspaces;
DROP TABLE IF EXISTS pai_raw_clickup_user;
DROP TABLE IF EXISTS pai_raw_trello_boards;

DROP TABLE IF EXISTS pai_raw_spotify_recent_tracks;
DROP TABLE IF EXISTS pai_raw_strava_activities;
DROP TABLE IF EXISTS pai_raw_todoist_tasks;
DROP TABLE IF EXISTS pai_raw_figma_user;
DROP TABLE IF EXISTS pai_raw_zoom_marketplace_apps;
DROP TABLE IF EXISTS pai_raw_zoom_user;
DROP TABLE IF EXISTS pai_raw_dropbox_files;
DROP TABLE IF EXISTS pai_raw_dropbox_account;
DROP TABLE IF EXISTS pai_raw_hubspot_contacts;

DROP TABLE IF EXISTS pai_raw_discord_guilds;
DROP TABLE IF EXISTS pai_raw_linkedin_organizations;
