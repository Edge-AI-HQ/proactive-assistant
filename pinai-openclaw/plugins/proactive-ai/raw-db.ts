/**
 * Raw data store — separate SQLite file (raw.db) holding source-typed
 * tables for connector / device snapshots that the evolution agent
 * consumes to derive memory.
 *
 * One table per source. Each table shares 4 conventional columns:
 *   id, occurred_at, ingested_at, dedupe_key
 * plus the v3 reference triple (reference_count, last_referenced_at,
 * referenced_by_runs).
 *
 * Connector specifics (e.g. gmail.from_addr, gcal.start_at) are first-class
 * columns. New connectors → new migration table.
 *
 * See docs/plans/memory-architecture.mdx §三 (raw.db) and §五 (reference cap).
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

let _rawDb: Database.Database | null = null;

function getRawDb(): Database.Database {
  if (_rawDb) return _rawDb;
  const home = process.env.OPENCLAW_HOME || '/app';
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'raw.db');
  _rawDb = new Database(dbPath);
  _rawDb.pragma('journal_mode = WAL');
  _rawDb.pragma('busy_timeout = 5000');
  ensureRawSchema(_rawDb);
  return _rawDb;
}

export function resetRawDbForTests(): void {
  if (_rawDb) {
    _rawDb.close();
    _rawDb = null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function genId(): string {
  return crypto.randomUUID();
}

function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(raw: string | null | undefined): T {
  if (!raw) return {} as T;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : {} as T;
  } catch {
    return {} as T;
  }
}

/**
 * Normalize an ISO-ish datetime string to canonical UTC ISO (`...Z`).
 * Different gcal providers emit `2026-04-23T08:00:00+08:00` /
 * `2026-04-23T00:00:00Z` / `2026-04-23` (all-day) etc.; without this,
 * `start_at >= ?` lexicographic comparisons across offsets are wrong.
 * Leaves unparseable input untouched so we never lose data, but in practice
 * every Date.parse-compatible string comes out the other side as UTC.
 */
function normalizeToUtcIso(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return trimmed;
  return d.toISOString();
}

/** Escape a LIKE pattern value so `%` / `_` / `\` match literally. */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const REFERENCED_BY_RUNS_CAP = 10;

function ensureRawSchema(db: Database.Database): void {
  db.exec(`
    -- Gmail messages (Composio / Google Workspace sync target)
    CREATE TABLE IF NOT EXISTS gmail_messages (
      id              TEXT PRIMARY KEY,
      message_id      TEXT NOT NULL UNIQUE,
      thread_id       TEXT,
      from_addr       TEXT,
      to_addrs_json   TEXT NOT NULL DEFAULT '[]',
      cc_addrs_json   TEXT NOT NULL DEFAULT '[]',
      subject         TEXT,
      snippet         TEXT,
      body            TEXT,
      label_ids_json  TEXT NOT NULL DEFAULT '[]',
      internal_date   TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_dedupe
      ON gmail_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gmail_thread ON gmail_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_gmail_occurred ON gmail_messages(occurred_at DESC);

    -- Google Calendar events
    CREATE TABLE IF NOT EXISTS gcal_events (
      id              TEXT PRIMARY KEY,
      calendar_id     TEXT NOT NULL,
      event_id        TEXT NOT NULL,
      title           TEXT,
      description     TEXT,
      location        TEXT,
      start_at        TEXT,
      end_at          TEXT,
      attendees_json  TEXT NOT NULL DEFAULT '[]',
      status          TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_dedupe
      ON gcal_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_natural
      ON gcal_events(calendar_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_gcal_start ON gcal_events(start_at DESC);

    -- Device-side full snapshots: installed app inventory
    CREATE TABLE IF NOT EXISTS device_apps_snapshot (
      id              TEXT PRIMARY KEY,
      snapshot_id     TEXT NOT NULL,
      device_id       TEXT NOT NULL,
      bundle_id       TEXT NOT NULL,
      app_name        TEXT NOT NULL,
      version         TEXT,
      last_used_at    TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_dedupe
      ON device_apps_snapshot(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_apps_device_captured
      ON device_apps_snapshot(device_id, occurred_at DESC);

    -- Device-side full snapshots: contacts
    CREATE TABLE IF NOT EXISTS device_contacts_snapshot (
      id              TEXT PRIMARY KEY,
      snapshot_id     TEXT NOT NULL,
      device_id       TEXT NOT NULL,
      display_name    TEXT,
      emails_json     TEXT NOT NULL DEFAULT '[]',
      phones_json     TEXT NOT NULL DEFAULT '[]',
      last_modified   TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_dedupe
      ON device_contacts_snapshot(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contacts_device_captured
      ON device_contacts_snapshot(device_id, occurred_at DESC);

    -- Device-side typed health observations. One table covers samples,
    -- daily summaries, sleep, workouts, alerts, and insights; query-critical
    -- fields stay first-class columns and payload_json keeps source detail.
    CREATE TABLE IF NOT EXISTS device_health_observations (
      id                  TEXT PRIMARY KEY,
      device_id           TEXT NOT NULL,
      observation_type    TEXT NOT NULL,
      metric              TEXT,
      value               REAL,
      unit                TEXT,
      start_at            TEXT,
      end_at              TEXT,
      local_date          TEXT,
      source_app          TEXT,
      payload_json        TEXT NOT NULL DEFAULT '{}',
      occurred_at         TEXT NOT NULL,
      ingested_at         TEXT NOT NULL,
      dedupe_key          TEXT,
      reference_count     INTEGER NOT NULL DEFAULT 0,
      last_referenced_at  TEXT,
      referenced_by_runs  TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_health_dedupe
      ON device_health_observations(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_health_device_time
      ON device_health_observations(device_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_health_metric_time
      ON device_health_observations(metric, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_health_local_date
      ON device_health_observations(device_id, local_date);

    -- Slack messages (Composio: SLACK_SEARCH_MESSAGES)
    --
    -- ts is the Slack-native id ("1714063221.000400"); not unique on its
    -- own across channels, so the natural-key index pairs (channel_id, ts).
    -- thread_ts is set when this message is a reply (or itself the parent
    -- of a thread); it's the parent ts.
    CREATE TABLE IF NOT EXISTS slack_messages (
      id              TEXT PRIMARY KEY,
      channel_id      TEXT NOT NULL,
      channel_name    TEXT,
      ts              TEXT NOT NULL,
      thread_ts       TEXT,
      user_id         TEXT,
      user_name       TEXT,
      text            TEXT,
      permalink       TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_dedupe
      ON slack_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_natural
      ON slack_messages(channel_id, ts);
    CREATE INDEX IF NOT EXISTS idx_slack_occurred ON slack_messages(occurred_at DESC);

    -- Notion pages (Composio: NOTION_FETCH_DATA, fetch_type='get_all')
    --
    -- page_id is the Notion-native id (UUID with dashes preserved as-is).
    -- parent_type captures whether this lives directly in workspace, under
    -- another page, or inside a database row — useful when downstream
    -- evolution wants to ignore database rows, or vice versa.
    CREATE TABLE IF NOT EXISTS notion_pages (
      id              TEXT PRIMARY KEY,
      page_id         TEXT NOT NULL UNIQUE,
      title           TEXT,
      url             TEXT,
      parent_id       TEXT,
      parent_type     TEXT,
      icon            TEXT,
      last_edited_time TEXT,
      created_time    TEXT,
      content_preview TEXT,
      archived        INTEGER NOT NULL DEFAULT 0,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notion_dedupe
      ON notion_pages(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_notion_edited ON notion_pages(last_edited_time DESC);

    -- Google Drive files (Composio: GOOGLEDRIVE_FIND_FILE)
    --
    -- size_bytes is nullable since Google Docs/Sheets/Slides are server-
    -- computed and don't report a file size. mime_type is the Workspace
    -- MIME (application/vnd.google-apps.document etc.) for Docs.
    CREATE TABLE IF NOT EXISTS gdrive_files (
      id              TEXT PRIMARY KEY,
      file_id         TEXT NOT NULL UNIQUE,
      name            TEXT,
      mime_type       TEXT,
      modified_time   TEXT,
      created_time    TEXT,
      size_bytes      INTEGER,
      web_view_link   TEXT,
      owners_json     TEXT NOT NULL DEFAULT '[]',
      trashed         INTEGER NOT NULL DEFAULT 0,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gdrive_dedupe
      ON gdrive_files(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gdrive_modified ON gdrive_files(modified_time DESC);

    -- GitHub issues + PRs (Composio: GITHUB_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER)
    --
    -- GitHub returns PRs through the issues endpoint with a "pull_request"
    -- object on the row; we keep the boolean as a separate column so
    -- downstream evolution can split issue-derived facts from PR-derived
    -- ones if it wants. issue_id is GitHubs stable global id (string-cast
    -- to keep types simple).
    CREATE TABLE IF NOT EXISTS github_issues (
      id                 TEXT PRIMARY KEY,
      issue_id           TEXT NOT NULL UNIQUE,
      number             INTEGER,
      repo_full_name     TEXT,
      title              TEXT,
      body_preview       TEXT,
      state              TEXT,
      html_url           TEXT,
      is_pull_request    INTEGER NOT NULL DEFAULT 0,
      labels_json        TEXT NOT NULL DEFAULT '[]',
      assignees_json     TEXT NOT NULL DEFAULT '[]',
      created_at_remote  TEXT,
      updated_at_remote  TEXT,
      occurred_at        TEXT NOT NULL,
      ingested_at        TEXT NOT NULL,
      dedupe_key         TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_issues_dedupe
      ON github_issues(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gh_issues_repo_state
      ON github_issues(repo_full_name, state, updated_at_remote DESC);

    -- Outlook messages (Composio: OUTLOOK_LIST_MESSAGES — Microsoft Graph)
    --
    -- Mirrors gmail_messages with Graph-specific fields: conversation_id
    -- (Graph's threading id, equivalent to Gmail's thread_id), importance
    -- ('low' | 'normal' | 'high'), has_attachments boolean.
    CREATE TABLE IF NOT EXISTS outlook_messages (
      id              TEXT PRIMARY KEY,
      message_id      TEXT NOT NULL UNIQUE,
      conversation_id TEXT,
      from_addr       TEXT,
      to_addrs_json   TEXT NOT NULL DEFAULT '[]',
      cc_addrs_json   TEXT NOT NULL DEFAULT '[]',
      subject         TEXT,
      body_preview    TEXT,
      received_at     TEXT,
      importance      TEXT,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      web_link        TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outlook_dedupe
      ON outlook_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_outlook_received ON outlook_messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outlook_conv ON outlook_messages(conversation_id);

    -- Google Docs documents (Composio: GOOGLEDOCS_SEARCH_DOCUMENTS — verified live)
    --
    -- Returns the same Drive-API row shape as gdrive_files but filtered to
    -- mime_type=application/vnd.google-apps.document. Kept as a separate
    -- table per the "one toolkit, one typed table" rule so connector
    -- boundaries are clean even when payload shapes overlap.
    CREATE TABLE IF NOT EXISTS gdocs_documents (
      id              TEXT PRIMARY KEY,
      document_id     TEXT NOT NULL UNIQUE,
      name            TEXT,
      modified_time   TEXT,
      created_time    TEXT,
      web_view_link   TEXT,
      owners_json     TEXT NOT NULL DEFAULT '[]',
      last_modifying_user TEXT,
      starred         INTEGER NOT NULL DEFAULT 0,
      trashed         INTEGER NOT NULL DEFAULT 0,
      shared          INTEGER NOT NULL DEFAULT 0,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gdocs_dedupe
      ON gdocs_documents(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gdocs_modified ON gdocs_documents(modified_time DESC);

    -- Google Sheets spreadsheets (Composio: GOOGLESHEETS_SEARCH_SPREADSHEETS)
    --
    -- Same Drive-API shape but for application/vnd.google-apps.spreadsheet.
    CREATE TABLE IF NOT EXISTS gsheets_spreadsheets (
      id              TEXT PRIMARY KEY,
      spreadsheet_id  TEXT NOT NULL UNIQUE,
      name            TEXT,
      modified_time   TEXT,
      created_time    TEXT,
      web_view_link   TEXT,
      owners_json     TEXT NOT NULL DEFAULT '[]',
      last_modifying_user TEXT,
      starred         INTEGER NOT NULL DEFAULT 0,
      trashed         INTEGER NOT NULL DEFAULT 0,
      shared          INTEGER NOT NULL DEFAULT 0,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gsheets_dedupe
      ON gsheets_spreadsheets(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gsheets_modified ON gsheets_spreadsheets(modified_time DESC);

    -- Stripe invoices (Composio: STRIPE_LIST_INVOICES — schema-derived,
    -- not live-verified — first deploy with a connected Stripe account
    -- should expect minor field-naming surprises and tighten the mapper).
    --
    -- Picked invoices over customers/charges for highest user-meaning per
    -- row. Amounts as INTEGER cents matching Stripe's wire format.
    -- customer_email/name denormalized so personal_signals derivation
    -- doesn't need a second customer-fetch round-trip.
    CREATE TABLE IF NOT EXISTS stripe_invoices (
      id              TEXT PRIMARY KEY,
      invoice_id      TEXT NOT NULL UNIQUE,
      number          TEXT,
      status          TEXT,
      amount_due      INTEGER,
      amount_paid     INTEGER,
      amount_remaining INTEGER,
      currency        TEXT,
      customer_id     TEXT,
      customer_email  TEXT,
      customer_name   TEXT,
      collection_method TEXT,
      created_at_remote TEXT,
      due_date        TEXT,
      hosted_invoice_url TEXT,
      invoice_pdf     TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_inv_dedupe
      ON stripe_invoices(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_stripe_inv_created
      ON stripe_invoices(created_at_remote DESC);
    CREATE INDEX IF NOT EXISTS idx_stripe_inv_status
      ON stripe_invoices(status);

    -- Discord guilds (Composio: DISCORD_LIST_MY_GUILDS — schema-derived,
    -- not live-verified). Discords public API for end-users is
    -- intentionally narrow — no "list my recent messages" surface,
    -- so we settle for guilds (servers) as the primary signal source.
    CREATE TABLE IF NOT EXISTS discord_guilds (
      id              TEXT PRIMARY KEY,
      guild_id        TEXT NOT NULL UNIQUE,
      name            TEXT,
      icon            TEXT,
      is_owner        INTEGER NOT NULL DEFAULT 0,
      permissions     TEXT,
      features_json   TEXT NOT NULL DEFAULT '[]',
      approximate_member_count INTEGER,
      approximate_presence_count INTEGER,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_guilds_dedupe
      ON discord_guilds(dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- Spotify recently played tracks (Composio: SPOTIFY_GET_RECENTLY_PLAYED_TRACKS)
    --
    -- Each row is a play event, NOT a track. The same track id can repeat
    -- across rows because the user replays it. Natural key is
    -- (track_id, played_at). artist_names_json is a flat list of artist
    -- names — the full artist objects from Spotify aren't needed for signal
    -- derivation. context_type captures whether the play came from a
    -- playlist / album / artist page (handy for evolve to spot listening
    -- habits — "user often listens via artist radio").
    CREATE TABLE IF NOT EXISTS spotify_recent_tracks (
      id              TEXT PRIMARY KEY,
      track_id        TEXT NOT NULL,
      track_name      TEXT,
      artist_names_json TEXT NOT NULL DEFAULT '[]',
      album_name      TEXT,
      duration_ms     INTEGER,
      popularity      INTEGER,
      track_url       TEXT,
      played_at       TEXT NOT NULL,
      context_type    TEXT,
      context_uri     TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spotify_recent_dedupe
      ON spotify_recent_tracks(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spotify_recent_natural
      ON spotify_recent_tracks(track_id, played_at);
    CREATE INDEX IF NOT EXISTS idx_spotify_recent_played
      ON spotify_recent_tracks(played_at DESC);

    -- Strava activities (Composio: STRAVA_LIST_ATHLETE_ACTIVITIES)
    --
    -- Each row is one workout. activity_id is Strava's globally-unique
    -- numeric id (we store as TEXT since SQLite's INTEGER caps before
    -- bigints in some bindings). distance / time use SI units (meters,
    -- seconds, m/s) — matches what Strava returns natively, no conversion.
    -- Heartrate fields nullable because not all activities/devices report.
    CREATE TABLE IF NOT EXISTS strava_activities (
      id              TEXT PRIMARY KEY,
      activity_id     TEXT NOT NULL UNIQUE,
      name            TEXT,
      activity_type   TEXT,
      distance_meters REAL,
      moving_time_seconds   INTEGER,
      elapsed_time_seconds  INTEGER,
      elevation_gain_meters REAL,
      start_date      TEXT,
      timezone        TEXT,
      average_speed_mps     REAL,
      max_speed_mps   REAL,
      average_heartrate INTEGER,
      max_heartrate   INTEGER,
      kudos_count     INTEGER,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_strava_dedupe
      ON strava_activities(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_strava_start
      ON strava_activities(start_date DESC);

    -- Todoist tasks (Composio: TODOIST_GET_ALL_TASKS)
    --
    -- Snapshot of incomplete tasks at fetch time. parent_task_id is set
    -- for sub-tasks. labels_json is a flat list of label strings.
    -- priority is 1-4 (1=normal, 4=urgent). Re-fetching the same task
    -- updates nothing (INSERT OR IGNORE on dedupe_key); on sync we re-
    -- pull and just see the same rows — Todoist doesn't ship a clean
    -- "modified-since" filter, so the dedup absorbs.
    CREATE TABLE IF NOT EXISTS todoist_tasks (
      id              TEXT PRIMARY KEY,
      task_id         TEXT NOT NULL UNIQUE,
      content         TEXT,
      description     TEXT,
      project_id      TEXT,
      parent_task_id  TEXT,
      priority        INTEGER,
      labels_json     TEXT NOT NULL DEFAULT '[]',
      due_at          TEXT,
      is_completed    INTEGER NOT NULL DEFAULT 0,
      created_at_remote TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_todoist_dedupe
      ON todoist_tasks(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_todoist_project
      ON todoist_tasks(project_id);

    -- YouTube subscriptions (Composio: YOUTUBE_LIST_USER_SUBSCRIPTIONS)
    --
    -- Channel-level snapshot — one row per channel the user follows.
    -- subscribed_at tracks when the user added the subscription (from the
    -- snippet.publishedAt field). YouTube doesn't expose watch history
    -- via Data API, so subs are the best proxy for "what the user cares
    -- about" available to us.
    CREATE TABLE IF NOT EXISTS youtube_subscriptions (
      id              TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL UNIQUE,
      channel_id      TEXT NOT NULL,
      channel_title   TEXT,
      channel_description TEXT,
      thumbnail_url   TEXT,
      subscribed_at   TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_youtube_subs_dedupe
      ON youtube_subscriptions(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_youtube_subs_channel
      ON youtube_subscriptions(channel_id);

    -- Trello boards (Composio: TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER)
    --
    -- One row per board the user has access to. closed=true means the
    -- board is archived. starred and pinned are user-level preference
    -- flags useful as importance signals.
    CREATE TABLE IF NOT EXISTS trello_boards (
      id              TEXT PRIMARY KEY,
      board_id        TEXT NOT NULL UNIQUE,
      name            TEXT,
      description     TEXT,
      url             TEXT,
      organization_id TEXT,
      closed          INTEGER NOT NULL DEFAULT 0,
      starred         INTEGER NOT NULL DEFAULT 0,
      pinned          INTEGER NOT NULL DEFAULT 0,
      last_activity_at TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trello_boards_dedupe
      ON trello_boards(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_trello_boards_activity
      ON trello_boards(last_activity_at DESC);

    -- Jira recent projects (Composio: JIRA_GET_RECENT_PROJECTS)
    --
    -- The action returns projects the authenticated user has accessed
    -- recently. project_key is the human-readable short code (e.g. PROJ).
    -- We dedupe on project_id (numeric Jira id) — re-fetching is idempotent.
    CREATE TABLE IF NOT EXISTS jira_projects (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL UNIQUE,
      project_key     TEXT,
      name            TEXT,
      description     TEXT,
      project_type    TEXT,
      lead_name       TEXT,
      url             TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_projects_dedupe
      ON jira_projects(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_jira_projects_key
      ON jira_projects(project_key);

    -- Twitter bookmarks (Composio: TWITTER_BOOKMARKS_BY_USER, id='me')
    --
    -- Each row is a bookmarked tweet. Same tweet bookmarked → unbookmarked →
    -- bookmarked again will dedup naturally on tweet_id; that's fine for
    -- our "what does the user save" signal.
    CREATE TABLE IF NOT EXISTS twitter_bookmarks (
      id              TEXT PRIMARY KEY,
      tweet_id        TEXT NOT NULL UNIQUE,
      author_username TEXT,
      author_id       TEXT,
      text            TEXT,
      lang            TEXT,
      created_at_remote TEXT,
      url             TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_twitter_bookmarks_dedupe
      ON twitter_bookmarks(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_twitter_bookmarks_created
      ON twitter_bookmarks(created_at_remote DESC);

    -- Calendly scheduled events (Composio: CALENDLY_LIST_SCHEDULED_EVENTS)
    --
    -- Note: the action requires the user URI as a parameter, which the
    -- handler resolves first via CALENDLY_GET_USER (uuid='me'). Each row
    -- is one booking. invitees_json captures attendee names/emails
    -- when present (Calendly's "invitees" sub-resource).
    CREATE TABLE IF NOT EXISTS calendly_events (
      id              TEXT PRIMARY KEY,
      event_uri       TEXT NOT NULL UNIQUE,
      name            TEXT,
      status          TEXT,
      start_at        TEXT,
      end_at          TEXT,
      location_type   TEXT,
      location_value  TEXT,
      invitees_json   TEXT NOT NULL DEFAULT '[]',
      meeting_url     TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calendly_events_dedupe
      ON calendly_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_calendly_events_start
      ON calendly_events(start_at DESC);

    -- LinkedIn profile (Composio: LINKEDIN_GET_MY_INFO)
    -- Singleton: 1 row per LinkedIn account. Re-fetch overwrites via
    -- dedupe on linkedin_id; fields like headline/picture do change so
    -- we want the latest snapshot but no history.
    CREATE TABLE IF NOT EXISTS linkedin_profile (
      id              TEXT PRIMARY KEY,
      linkedin_id     TEXT NOT NULL UNIQUE,
      first_name      TEXT,
      last_name       TEXT,
      localized_name  TEXT,
      headline        TEXT,
      vanity_name     TEXT,
      picture_url     TEXT,
      profile_url     TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_profile_dedupe
      ON linkedin_profile(dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- LinkedIn organizations (Composio: LINKEDIN_GET_COMPANY_INFO)
    -- Each row = (organization, role) pair the user holds. The same org
    -- with the user holding two roles → 2 rows. role_state distinguishes
    -- APPROVED vs REQUESTED memberships.
    CREATE TABLE IF NOT EXISTS linkedin_organizations (
      id              TEXT PRIMARY KEY,
      org_urn         TEXT NOT NULL,
      org_id          TEXT,
      role            TEXT,
      role_state      TEXT,
      org_name        TEXT,
      org_url         TEXT,
      logo_url        TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_linkedin_orgs_dedupe
      ON linkedin_organizations(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_linkedin_orgs_role ON linkedin_organizations(role);

    -- Figma user (Composio: FIGMA_GET_CURRENT_USER)
    -- Singleton; activity logs are Enterprise-only and skipped.
    CREATE TABLE IF NOT EXISTS figma_user (
      id              TEXT PRIMARY KEY,
      figma_id        TEXT NOT NULL UNIQUE,
      email           TEXT,
      handle          TEXT,
      img_url         TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_figma_user_dedupe
      ON figma_user(dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- Zoom user (Composio: ZOOM_GET_USER, userId='me')
    -- Singleton. account_type encodes Basic/Licensed/On-Prem; useful as
    -- "user has paid Zoom" / "user is on org plan" signal.
    CREATE TABLE IF NOT EXISTS zoom_user (
      id              TEXT PRIMARY KEY,
      zoom_id         TEXT NOT NULL UNIQUE,
      email           TEXT,
      first_name      TEXT,
      last_name       TEXT,
      display_name    TEXT,
      account_type    INTEGER,
      role_name       TEXT,
      department      TEXT,
      timezone        TEXT,
      location        TEXT,
      language        TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_zoom_user_dedupe
      ON zoom_user(dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- Zoom marketplace user apps (Composio: ZOOM_GET_MARKETPLACE_USER_APPS, id='me')
    -- The user's installed Zoom integrations (Salesforce, HubSpot, Slack
    -- bridges, etc.) — strong workflow signal: tells us what other tools
    -- the user has wired into Zoom.
    CREATE TABLE IF NOT EXISTS zoom_marketplace_apps (
      id              TEXT PRIMARY KEY,
      app_install_id  TEXT NOT NULL UNIQUE,
      app_id          TEXT,
      name            TEXT,
      publisher       TEXT,
      install_state   TEXT,
      app_type        TEXT,
      installed_at    TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_zoom_apps_dedupe
      ON zoom_marketplace_apps(dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- Dropbox account (Composio: DROPBOX_GET_ABOUT_ME)
    -- Singleton. account_type is one of basic/pro/business — useful for
    -- "user has paid Dropbox" / "user is in a business team" signals.
    CREATE TABLE IF NOT EXISTS dropbox_account (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL UNIQUE,
      email           TEXT,
      display_name    TEXT,
      given_name      TEXT,
      surname         TEXT,
      account_type    TEXT,
      country         TEXT,
      locale          TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dropbox_account_dedupe
      ON dropbox_account(dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- Dropbox files (Composio: DROPBOX_LIST_FOLDER, path='')
    -- Root-level files and folders. tag distinguishes 'file' vs 'folder'.
    -- Init pulls root only; deeper paths can be added later if needed.
    CREATE TABLE IF NOT EXISTS dropbox_files (
      id              TEXT PRIMARY KEY,
      file_id         TEXT NOT NULL UNIQUE,
      tag             TEXT,
      name            TEXT,
      path_lower      TEXT,
      path_display    TEXT,
      size_bytes      INTEGER,
      server_modified TEXT,
      client_modified TEXT,
      rev             TEXT,
      is_downloadable INTEGER NOT NULL DEFAULT 1,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dropbox_files_dedupe
      ON dropbox_files(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dropbox_files_modified
      ON dropbox_files(server_modified DESC);

    -- Asana workspaces (Composio: ASANA_GET_WORKSPACES)
    -- One row per workspace the user has access to.
    CREATE TABLE IF NOT EXISTS asana_workspaces (
      id              TEXT PRIMARY KEY,
      workspace_gid   TEXT NOT NULL UNIQUE,
      name            TEXT,
      resource_type   TEXT,
      is_organization INTEGER NOT NULL DEFAULT 0,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_asana_ws_dedupe
      ON asana_workspaces(dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- Asana tasks (Composio: ASANA_GET_MULTIPLE_TASKS, assignee='me' per workspace)
    -- Two-step fetch: first list workspaces, then for each workspace
    -- query tasks assigned to me. Tasks across workspaces share this
    -- table; workspace_gid column tracks origin.
    CREATE TABLE IF NOT EXISTS asana_tasks (
      id              TEXT PRIMARY KEY,
      task_gid        TEXT NOT NULL UNIQUE,
      workspace_gid   TEXT,
      project_gid     TEXT,
      name            TEXT,
      notes           TEXT,
      completed       INTEGER NOT NULL DEFAULT 0,
      assignee_status TEXT,
      due_at          TEXT,
      due_on          TEXT,
      modified_at_remote TEXT,
      created_at_remote  TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_asana_tasks_dedupe
      ON asana_tasks(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_asana_tasks_modified
      ON asana_tasks(modified_at_remote DESC);

    -- HubSpot contacts (Composio: HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA)
    -- Pulls the most recently-modified contacts from the user's CRM
    -- portal — strong signal for B2B / sales-role users about who they
    -- engage with. We don't filter by owner because that requires a
    -- separate owner-id discovery step; the broad view is OK for evolve.
    CREATE TABLE IF NOT EXISTS hubspot_contacts (
      id              TEXT PRIMARY KEY,
      contact_id      TEXT NOT NULL UNIQUE,
      email           TEXT,
      first_name      TEXT,
      last_name       TEXT,
      company         TEXT,
      jobtitle        TEXT,
      lifecycle_stage TEXT,
      lead_status     TEXT,
      created_at_remote TEXT,
      modified_at_remote TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hubspot_contacts_dedupe
      ON hubspot_contacts(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_hubspot_contacts_modified
      ON hubspot_contacts(modified_at_remote DESC);

    -- ClickUp user (Composio: CLICKUP_GET_AUTHORIZED_USER)
    CREATE TABLE IF NOT EXISTS clickup_user (
      id              TEXT PRIMARY KEY,
      clickup_id      TEXT NOT NULL UNIQUE,
      username        TEXT,
      email           TEXT,
      color           TEXT,
      profile_picture TEXT,
      timezone        TEXT,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clickup_user_dedupe
      ON clickup_user(dedupe_key) WHERE dedupe_key IS NOT NULL;

    -- ClickUp workspaces (Composio: CLICKUP_AUTHORIZATION_GET_WORK_SPACE_LIST)
    -- ClickUp calls these "Teams" but the API word is workspace. Members
    -- count is derived from the array length on each row at fetch time.
    CREATE TABLE IF NOT EXISTS clickup_workspaces (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL UNIQUE,
      name            TEXT,
      color           TEXT,
      avatar          TEXT,
      members_count   INTEGER,
      occurred_at     TEXT NOT NULL,
      ingested_at     TEXT NOT NULL,
      dedupe_key      TEXT,
      reference_count    INTEGER NOT NULL DEFAULT 0,
      last_referenced_at TEXT,
      referenced_by_runs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clickup_ws_dedupe
      ON clickup_workspaces(dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
}

// ─────── Gmail messages ───────

export interface GmailMessageInput {
  messageId: string;
  threadId?: string | null;
  from?: string | null;
  to?: string[];
  cc?: string[];
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
  labelIds?: string[];
  internalDate?: string | null;
  /** ISO timestamp of when the message was sent/received. Falls back to internalDate. */
  occurredAt?: string;
  /** Optional explicit dedupe_key; defaults to "gmail:msg:<messageId>". */
  dedupeKey?: string;
}

export interface GmailMessageRow {
  id: string;
  message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  snippet: string | null;
  body: string | null;
  label_ids: string[];
  internal_date: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToGmailMessage(row: any): GmailMessageRow {
  return {
    id: row.id,
    message_id: row.message_id,
    thread_id: row.thread_id ?? null,
    from_addr: row.from_addr ?? null,
    to_addrs: parseJsonArray<string>(row.to_addrs_json),
    cc_addrs: parseJsonArray<string>(row.cc_addrs_json),
    subject: row.subject ?? null,
    snippet: row.snippet ?? null,
    body: row.body ?? null,
    label_ids: parseJsonArray<string>(row.label_ids_json),
    internal_date: row.internal_date ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export interface IngestResult { accepted: number; inserted: number; ignored: number; ids: string[] }

export function ingestGmailMessages(items: GmailMessageInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gmail_messages (
       id, message_id, thread_id, from_addr, to_addrs_json, cc_addrs_json,
       subject, snippet, body, label_ids_json, internal_date,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.messageId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = item.occurredAt ?? item.internalDate ?? ts;
      const dedupe = item.dedupeKey ?? `gmail:msg:${item.messageId}`;
      const result = insert.run(
        id, item.messageId, item.threadId ?? null,
        item.from ?? null, JSON.stringify(item.to ?? []),
        JSON.stringify(item.cc ?? []),
        item.subject ?? null, item.snippet ?? null, item.body ?? null,
        JSON.stringify(item.labelIds ?? []), item.internalDate ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export interface ListGmailOpts {
  since?: string;
  until?: string;
  threadId?: string;
  limit?: number;
}

export function listGmailMessages(opts: ListGmailOpts = {}): GmailMessageRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM gmail_messages WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.since) { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until) { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  if (opts.threadId) { parts.push('AND thread_id = ?'); params.push(opts.threadId); }
  parts.push('ORDER BY occurred_at DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToGmailMessage);
}

export function countGmailMessages(opts: ListGmailOpts = {}): number {
  const db = getRawDb();
  const parts = ['SELECT COUNT(*) AS total FROM gmail_messages WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.since) { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until) { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  if (opts.threadId) { parts.push('AND thread_id = ?'); params.push(opts.threadId); }
  const row = db.prepare(parts.join(' ')).get(...params) as { total?: number } | undefined;
  return row?.total ?? 0;
}

// ─────── Google Calendar events ───────

export interface GcalEventInput {
  calendarId: string;
  eventId: string;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  attendees?: string[];
  status?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface GcalEventRow {
  id: string;
  calendar_id: string;
  event_id: string;
  title: string | null;
  description: string | null;
  location: string | null;
  start_at: string | null;
  end_at: string | null;
  attendees: string[];
  status: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToGcalEvent(row: any): GcalEventRow {
  return {
    id: row.id,
    calendar_id: row.calendar_id,
    event_id: row.event_id,
    title: row.title ?? null,
    description: row.description ?? null,
    location: row.location ?? null,
    start_at: row.start_at ?? null,
    end_at: row.end_at ?? null,
    attendees: parseJsonArray<string>(row.attendees_json),
    status: row.status ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestGcalEvents(items: GcalEventInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gcal_events (
       id, calendar_id, event_id, title, description, location,
       start_at, end_at, attendees_json, status,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.calendarId || !item.eventId) continue;
      accepted += 1;
      const id = genId();
      // Normalize all time columns to UTC ISO so lexicographic comparisons
      // in listGcalEvents() are meaningful across mixed-offset sources.
      const startAt = normalizeToUtcIso(item.startAt ?? null);
      const endAt = normalizeToUtcIso(item.endAt ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? item.startAt ?? ts) ?? ts;
      const dedupe = item.dedupeKey ?? `gcal:evt:${item.calendarId}:${item.eventId}`;
      const result = insert.run(
        id, item.calendarId, item.eventId,
        item.title ?? null, item.description ?? null, item.location ?? null,
        startAt, endAt,
        JSON.stringify(item.attendees ?? []), item.status ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export interface ListGcalOpts {
  since?: string;
  until?: string;
  calendarId?: string;
  limit?: number;
}

export function listGcalEvents(opts: ListGcalOpts = {}): GcalEventRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM gcal_events WHERE 1=1'];
  const params: unknown[] = [];
  // Normalize filter bounds too — caller may pass `2026-04-23` or a
  // non-UTC ISO. Paired with UTC-normalized `start_at` on ingest, this
  // keeps lexicographic comparison correct.
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND start_at >= ?'); params.push(since); }
  if (until) { parts.push('AND start_at <= ?'); params.push(until); }
  if (opts.calendarId) { parts.push('AND calendar_id = ?'); params.push(opts.calendarId); }
  parts.push('ORDER BY start_at ASC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToGcalEvent);
}

export function countGcalEvents(opts: ListGcalOpts = {}): number {
  const db = getRawDb();
  const parts = ['SELECT COUNT(*) AS total FROM gcal_events WHERE 1=1'];
  const params: unknown[] = [];
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND start_at >= ?'); params.push(since); }
  if (until) { parts.push('AND start_at <= ?'); params.push(until); }
  if (opts.calendarId) { parts.push('AND calendar_id = ?'); params.push(opts.calendarId); }
  const row = db.prepare(parts.join(' ')).get(...params) as { total?: number } | undefined;
  return row?.total ?? 0;
}

// ─────── Device snapshots ───────

export interface DeviceAppSnapshotItem {
  bundleId: string;
  appName: string;
  version?: string | null;
  lastUsedAt?: string | null;
}

export interface IngestDeviceAppsInput {
  deviceId: string;
  capturedAt?: string;
  apps: DeviceAppSnapshotItem[];
  /** Optional snapshot id; defaults to a UUID. */
  snapshotId?: string;
}

export function ingestDeviceAppsSnapshot(input: IngestDeviceAppsInput): IngestResult {
  if (!input.deviceId) throw new Error('ingestDeviceAppsSnapshot: deviceId is required');
  if (input.apps.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const captured = input.capturedAt ?? ts;
  const snapshotId = input.snapshotId ?? genId();
  const ids: string[] = [];
  let inserted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO device_apps_snapshot (
       id, snapshot_id, device_id, bundle_id, app_name, version, last_used_at,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const app of input.apps) {
      if (!app.bundleId || !app.appName) continue;
      const id = genId();
      const dedupe = `device_apps:${input.deviceId}:${snapshotId}:${app.bundleId}`;
      const result = insert.run(
        id, snapshotId, input.deviceId, app.bundleId, app.appName,
        app.version ?? null, app.lastUsedAt ?? null,
        captured, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted: input.apps.length, inserted, ignored: input.apps.length - inserted, ids };
}

export function replaceDeviceAppsSnapshot(input: IngestDeviceAppsInput): IngestResult {
  // Full sync semantics for snapshot tables are "new current snapshot",
  // not historical deletion. Readers that want current state already use
  // latestSnapshotOnly, so old rows remain available for references.
  return ingestDeviceAppsSnapshot(input);
}

export interface DeviceAppRow {
  id: string;
  snapshot_id: string;
  device_id: string;
  bundle_id: string;
  app_name: string;
  version: string | null;
  last_used_at: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToDeviceApp(row: any): DeviceAppRow {
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    device_id: row.device_id,
    bundle_id: row.bundle_id,
    app_name: row.app_name,
    version: row.version ?? null,
    last_used_at: row.last_used_at ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function listDeviceApps(opts: {
  deviceId?: string;
  snapshotId?: string;
  latestSnapshotOnly?: boolean;
  /** ISO timestamp; only snapshots with occurred_at >= since are considered. */
  since?: string;
  /** ISO timestamp; only snapshots with occurred_at <= until are considered. */
  until?: string;
  limit?: number;
} = {}): DeviceAppRow[] {
  const db = getRawDb();
  let snapshotId = opts.snapshotId;
  if (!snapshotId && opts.latestSnapshotOnly) {
    // Pick the latest snapshot in the (optional) time window for the device
    const latestParts = ['SELECT snapshot_id FROM device_apps_snapshot WHERE 1=1'];
    const latestParams: unknown[] = [];
    if (opts.deviceId) { latestParts.push('AND device_id = ?'); latestParams.push(opts.deviceId); }
    if (opts.since)    { latestParts.push('AND occurred_at >= ?'); latestParams.push(opts.since); }
    if (opts.until)    { latestParts.push('AND occurred_at <= ?'); latestParams.push(opts.until); }
    latestParts.push('ORDER BY occurred_at DESC LIMIT 1');
    const row = db.prepare(latestParts.join(' ')).get(...latestParams) as { snapshot_id?: string } | undefined;
    snapshotId = row?.snapshot_id;
    if (!snapshotId) return [];
  }
  const parts = ['SELECT * FROM device_apps_snapshot WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.deviceId) { parts.push('AND device_id = ?'); params.push(opts.deviceId); }
  if (snapshotId)    { parts.push('AND snapshot_id = ?'); params.push(snapshotId); }
  if (opts.since)    { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until)    { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  parts.push('ORDER BY app_name ASC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 100, 1000)));
  return (db.prepare(parts.join(' ')).all(...params) as any[]).map(rowToDeviceApp);
}

export function countDeviceApps(opts: {
  deviceId?: string;
  snapshotId?: string;
  latestSnapshotOnly?: boolean;
  since?: string;
  until?: string;
} = {}): number {
  const db = getRawDb();
  let snapshotId = opts.snapshotId;
  if (!snapshotId && opts.latestSnapshotOnly) {
    const latestParts = ['SELECT snapshot_id FROM device_apps_snapshot WHERE 1=1'];
    const latestParams: unknown[] = [];
    if (opts.deviceId) { latestParts.push('AND device_id = ?'); latestParams.push(opts.deviceId); }
    if (opts.since)    { latestParts.push('AND occurred_at >= ?'); latestParams.push(opts.since); }
    if (opts.until)    { latestParts.push('AND occurred_at <= ?'); latestParams.push(opts.until); }
    latestParts.push('ORDER BY occurred_at DESC LIMIT 1');
    const latest = db.prepare(latestParts.join(' ')).get(...latestParams) as { snapshot_id?: string } | undefined;
    snapshotId = latest?.snapshot_id;
    if (!snapshotId) return 0;
  }
  const parts = ['SELECT COUNT(*) AS total FROM device_apps_snapshot WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.deviceId) { parts.push('AND device_id = ?'); params.push(opts.deviceId); }
  if (snapshotId)    { parts.push('AND snapshot_id = ?'); params.push(snapshotId); }
  if (opts.since)    { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until)    { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  const row = db.prepare(parts.join(' ')).get(...params) as { total?: number } | undefined;
  return row?.total ?? 0;
}

export interface DeviceContactSnapshotItem {
  displayName?: string | null;
  emails?: string[];
  phones?: string[];
  lastModified?: string | null;
}

export interface IngestDeviceContactsInput {
  deviceId: string;
  capturedAt?: string;
  contacts: DeviceContactSnapshotItem[];
  snapshotId?: string;
}

export interface DeviceContactRow {
  id: string;
  snapshot_id: string;
  device_id: string;
  display_name: string | null;
  emails: string[];
  phones: string[];
  last_modified: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToDeviceContact(row: any): DeviceContactRow {
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    device_id: row.device_id,
    display_name: row.display_name ?? null,
    emails: parseJsonArray<string>(row.emails_json),
    phones: parseJsonArray<string>(row.phones_json),
    last_modified: row.last_modified ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function listDeviceContacts(opts: {
  deviceId?: string;
  snapshotId?: string;
  latestSnapshotOnly?: boolean;
  since?: string;
  until?: string;
  /** Substring match on display_name / emails / phones (case-insensitive). */
  search?: string;
  limit?: number;
} = {}): DeviceContactRow[] {
  const db = getRawDb();
  let snapshotId = opts.snapshotId;
  if (!snapshotId && opts.latestSnapshotOnly) {
    const latestParts = ['SELECT snapshot_id FROM device_contacts_snapshot WHERE 1=1'];
    const latestParams: unknown[] = [];
    if (opts.deviceId) { latestParts.push('AND device_id = ?'); latestParams.push(opts.deviceId); }
    if (opts.since)    { latestParts.push('AND occurred_at >= ?'); latestParams.push(opts.since); }
    if (opts.until)    { latestParts.push('AND occurred_at <= ?'); latestParams.push(opts.until); }
    latestParts.push('ORDER BY occurred_at DESC LIMIT 1');
    const row = db.prepare(latestParts.join(' ')).get(...latestParams) as { snapshot_id?: string } | undefined;
    snapshotId = row?.snapshot_id;
    if (!snapshotId) return [];
  }
  const parts = ['SELECT * FROM device_contacts_snapshot WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.deviceId) { parts.push('AND device_id = ?'); params.push(opts.deviceId); }
  if (snapshotId)    { parts.push('AND snapshot_id = ?'); params.push(snapshotId); }
  if (opts.since)    { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until)    { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  // Push search into SQL so the caller's LIMIT applies *after* filtering.
  // The previous "LIMIT then filter in JS" approach silently dropped
  // matches outside the default 200-row window. We match against
  // display_name and the raw JSON blobs for emails/phones — LIKE on the
  // serialized array is adequate for substring needs and avoids cracking
  // JSON per row in SQLite.
  if (opts.search) {
    const pat = `%${escapeLike(opts.search).toLowerCase()}%`;
    parts.push(`AND (
      LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(emails_json) LIKE ? ESCAPE '\\'
      OR LOWER(phones_json) LIKE ? ESCAPE '\\'
    )`);
    params.push(pat, pat, pat);
  }
  parts.push('ORDER BY display_name ASC NULLS LAST LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 200, 2000)));
  return (db.prepare(parts.join(' ')).all(...params) as any[]).map(rowToDeviceContact);
}

export function countDeviceContacts(opts: {
  deviceId?: string;
  snapshotId?: string;
  latestSnapshotOnly?: boolean;
  since?: string;
  until?: string;
  search?: string;
} = {}): number {
  const db = getRawDb();
  let snapshotId = opts.snapshotId;
  if (!snapshotId && opts.latestSnapshotOnly) {
    const latestParts = ['SELECT snapshot_id FROM device_contacts_snapshot WHERE 1=1'];
    const latestParams: unknown[] = [];
    if (opts.deviceId) { latestParts.push('AND device_id = ?'); latestParams.push(opts.deviceId); }
    if (opts.since)    { latestParts.push('AND occurred_at >= ?'); latestParams.push(opts.since); }
    if (opts.until)    { latestParts.push('AND occurred_at <= ?'); latestParams.push(opts.until); }
    latestParts.push('ORDER BY occurred_at DESC LIMIT 1');
    const latest = db.prepare(latestParts.join(' ')).get(...latestParams) as { snapshot_id?: string } | undefined;
    snapshotId = latest?.snapshot_id;
    if (!snapshotId) return 0;
  }
  const parts = ['SELECT COUNT(*) AS total FROM device_contacts_snapshot WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.deviceId) { parts.push('AND device_id = ?'); params.push(opts.deviceId); }
  if (snapshotId)    { parts.push('AND snapshot_id = ?'); params.push(snapshotId); }
  if (opts.since)    { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until)    { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  if (opts.search) {
    const pat = `%${escapeLike(opts.search).toLowerCase()}%`;
    parts.push(`AND (
      LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\'
      OR LOWER(emails_json) LIKE ? ESCAPE '\\'
      OR LOWER(phones_json) LIKE ? ESCAPE '\\'
    )`);
    params.push(pat, pat, pat);
  }
  const row = db.prepare(parts.join(' ')).get(...params) as { total?: number } | undefined;
  return row?.total ?? 0;
}

export function ingestDeviceContactsSnapshot(input: IngestDeviceContactsInput): IngestResult {
  if (!input.deviceId) throw new Error('ingestDeviceContactsSnapshot: deviceId is required');
  if (input.contacts.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const captured = input.capturedAt ?? ts;
  const snapshotId = input.snapshotId ?? genId();
  const ids: string[] = [];
  let inserted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO device_contacts_snapshot (
       id, snapshot_id, device_id, display_name, emails_json, phones_json,
       last_modified, occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    let idx = 0;
    for (const c of input.contacts) {
      idx += 1;
      const id = genId();
      const emailsKey = (c.emails ?? []).slice().sort().join(',');
      const phonesKey = (c.phones ?? []).slice().sort().join(',');
      const dedupe = `device_contacts:${input.deviceId}:${snapshotId}:${idx}:${emailsKey}|${phonesKey}`;
      const result = insert.run(
        id, snapshotId, input.deviceId, c.displayName ?? null,
        JSON.stringify(c.emails ?? []), JSON.stringify(c.phones ?? []),
        c.lastModified ?? null, captured, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted: input.contacts.length, inserted, ignored: input.contacts.length - inserted, ids };
}

export function replaceDeviceContactsSnapshot(input: IngestDeviceContactsInput): IngestResult {
  return ingestDeviceContactsSnapshot(input);
}

// ─────── Device health observations ───────

export interface DeviceHealthObservationInput {
  id?: string;
  observationType: string;
  metric?: string | null;
  value?: number | null;
  unit?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  localDate?: string | null;
  sourceApp?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: string | null;
  dedupeKey?: string | null;
}

export interface IngestDeviceHealthInput {
  deviceId: string;
  observations: DeviceHealthObservationInput[];
}

export interface DeviceHealthReplaceScope {
  deviceId: string;
  localDate?: string | null;
  metric?: string | null;
}

export interface DeviceHealthObservationRow {
  id: string;
  device_id: string;
  observation_type: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  start_at: string | null;
  end_at: string | null;
  local_date: string | null;
  source_app: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToDeviceHealthObservation(row: any): DeviceHealthObservationRow {
  return {
    id: row.id,
    device_id: row.device_id,
    observation_type: row.observation_type,
    metric: row.metric ?? null,
    value: typeof row.value === 'number' ? row.value : null,
    unit: row.unit ?? null,
    start_at: row.start_at ?? null,
    end_at: row.end_at ?? null,
    local_date: row.local_date ?? null,
    source_app: row.source_app ?? null,
    payload: parseJsonObject<Record<string, unknown>>(row.payload_json),
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

function defaultHealthDedupe(deviceId: string, item: DeviceHealthObservationInput): string {
  if (item.dedupeKey?.trim()) return item.dedupeKey.trim();
  if (item.id?.trim()) return `device_health:${deviceId}:id:${item.id.trim()}`;
  const timeKey = item.startAt ?? item.endAt ?? item.localDate ?? item.occurredAt ?? 'unknown_time';
  return [
    'device_health',
    deviceId,
    item.observationType,
    item.metric ?? '',
    timeKey,
    item.unit ?? '',
    item.sourceApp ?? '',
  ].join(':');
}

function insertDeviceHealthObservations(
  db: Database.Database,
  input: IngestDeviceHealthInput,
  ingestedAt: string,
): IngestResult {
  const ids: string[] = [];
  let accepted = 0;
  let inserted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO device_health_observations (
       id, device_id, observation_type, metric, value, unit,
       start_at, end_at, local_date, source_app, payload_json,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  for (const item of input.observations) {
    if (!item.observationType) continue;
    accepted += 1;
    const id = item.id ?? genId();
    const startAt = normalizeToUtcIso(item.startAt);
    const endAt = normalizeToUtcIso(item.endAt);
    const occurredAt = normalizeToUtcIso(item.occurredAt)
      ?? endAt
      ?? startAt
      ?? ingestedAt;
    const dedupe = defaultHealthDedupe(input.deviceId, item);
    const result = insert.run(
      id,
      input.deviceId,
      item.observationType,
      item.metric ?? null,
      typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null,
      item.unit ?? null,
      startAt,
      endAt,
      item.localDate ?? null,
      item.sourceApp ?? null,
      JSON.stringify(item.payload ?? {}),
      occurredAt,
      ingestedAt,
      dedupe,
    );
    if (result.changes > 0) {
      inserted += 1;
      ids.push(id);
    }
  }
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function ingestDeviceHealthObservations(input: IngestDeviceHealthInput): IngestResult {
  if (!input.deviceId) throw new Error('ingestDeviceHealthObservations: deviceId is required');
  if (input.observations.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const tx = db.transaction(() => insertDeviceHealthObservations(db, input, ts));
  return tx();
}

export function replaceDeviceHealthObservations(
  scope: DeviceHealthReplaceScope,
  input: IngestDeviceHealthInput,
): IngestResult {
  if (!scope.deviceId || !input.deviceId) throw new Error('replaceDeviceHealthObservations: deviceId is required');
  if (scope.deviceId !== input.deviceId) throw new Error('replaceDeviceHealthObservations: scope deviceId must match input deviceId');
  if (!scope.localDate && !scope.metric) {
    throw new Error('replaceDeviceHealthObservations: localDate or metric scope is required');
  }
  const db = getRawDb();
  const ts = nowIso();
  const tx = db.transaction(() => {
    // Full health sync refreshes only the unreferenced current slice; referenced rows are immutable raw evidence.
    const parts = ['DELETE FROM device_health_observations WHERE device_id = ? AND reference_count = 0'];
    const params: unknown[] = [scope.deviceId];
    if (scope.localDate) { parts.push('AND local_date = ?'); params.push(scope.localDate); }
    if (scope.metric) { parts.push('AND metric = ?'); params.push(scope.metric); }
    db.prepare(parts.join(' ')).run(...params);
    return insertDeviceHealthObservations(db, input, ts);
  });
  return tx();
}

export function listDeviceHealthObservations(opts: {
  deviceId?: string;
  observationType?: string;
  metric?: string;
  localDate?: string;
  since?: string;
  until?: string;
  limit?: number;
} = {}): DeviceHealthObservationRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM device_health_observations WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.deviceId) { parts.push('AND device_id = ?'); params.push(opts.deviceId); }
  if (opts.observationType) { parts.push('AND observation_type = ?'); params.push(opts.observationType); }
  if (opts.metric) { parts.push('AND metric = ?'); params.push(opts.metric); }
  if (opts.localDate) { parts.push('AND local_date = ?'); params.push(opts.localDate); }
  if (opts.since) { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until) { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  parts.push('ORDER BY occurred_at DESC, id DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 200, 2000)));
  return (db.prepare(parts.join(' ')).all(...params) as any[]).map(rowToDeviceHealthObservation);
}

export function countDeviceHealthObservations(opts: {
  deviceId?: string;
  observationType?: string;
  metric?: string;
  localDate?: string;
  since?: string;
  until?: string;
} = {}): number {
  const db = getRawDb();
  const parts = ['SELECT COUNT(*) AS total FROM device_health_observations WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.deviceId) { parts.push('AND device_id = ?'); params.push(opts.deviceId); }
  if (opts.observationType) { parts.push('AND observation_type = ?'); params.push(opts.observationType); }
  if (opts.metric) { parts.push('AND metric = ?'); params.push(opts.metric); }
  if (opts.localDate) { parts.push('AND local_date = ?'); params.push(opts.localDate); }
  if (opts.since) { parts.push('AND occurred_at >= ?'); params.push(opts.since); }
  if (opts.until) { parts.push('AND occurred_at <= ?'); params.push(opts.until); }
  const row = db.prepare(parts.join(' ')).get(...params) as { total?: number } | undefined;
  return row?.total ?? 0;
}

// ─────── Reference tracking — uniform across every raw table ───────

// ─────── Slack messages ───────

export interface SlackMessageInput {
  channelId: string;
  channelName?: string | null;
  ts: string;                  // Slack-native message id
  threadTs?: string | null;
  userId?: string | null;
  userName?: string | null;
  text?: string | null;
  permalink?: string | null;
  /** ISO timestamp; falls back to deriving from `ts`. */
  occurredAt?: string;
  dedupeKey?: string;
}

export interface SlackMessageRow {
  id: string;
  channel_id: string;
  channel_name: string | null;
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  user_name: string | null;
  text: string | null;
  permalink: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToSlackMessage(row: any): SlackMessageRow {
  return {
    id: row.id,
    channel_id: row.channel_id,
    channel_name: row.channel_name ?? null,
    ts: row.ts,
    thread_ts: row.thread_ts ?? null,
    user_id: row.user_id ?? null,
    user_name: row.user_name ?? null,
    text: row.text ?? null,
    permalink: row.permalink ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

/**
 * Idempotent batch insert. Slack timestamps look like "1714063221.000400";
 * we treat them as seconds-since-epoch + microseconds and convert to ISO
 * for occurred_at. Items with falsy channelId or ts are silently skipped.
 */
export function ingestSlackMessages(items: SlackMessageInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO slack_messages (
       id, channel_id, channel_name, ts, thread_ts,
       user_id, user_name, text, permalink,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.channelId || !item.ts) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = item.occurredAt ?? slackTsToIso(item.ts) ?? ts;
      const dedupe = item.dedupeKey ?? `slack:msg:${item.channelId}:${item.ts}`;
      const result = insert.run(
        id, item.channelId, item.channelName ?? null,
        item.ts, item.threadTs ?? null,
        item.userId ?? null, item.userName ?? null,
        item.text ?? null, item.permalink ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

function slackTsToIso(ts: string): string | null {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

export interface ListSlackOpts {
  channelId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export function listSlackMessages(opts: ListSlackOpts = {}): SlackMessageRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM slack_messages WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.channelId) { parts.push('AND channel_id = ?'); params.push(opts.channelId); }
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND occurred_at >= ?'); params.push(since); }
  if (until) { parts.push('AND occurred_at <= ?'); params.push(until); }
  parts.push('ORDER BY occurred_at DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToSlackMessage);
}

// ─────── Notion pages ───────

export interface NotionPageInput {
  pageId: string;
  title?: string | null;
  url?: string | null;
  parentId?: string | null;
  parentType?: string | null;     // 'workspace' | 'page_id' | 'database_id'
  icon?: string | null;
  lastEditedTime?: string | null;
  createdTime?: string | null;
  contentPreview?: string | null;
  archived?: boolean;
  /** ISO timestamp; falls back to lastEditedTime then createdTime then now. */
  occurredAt?: string;
  dedupeKey?: string;
}

export interface NotionPageRow {
  id: string;
  page_id: string;
  title: string | null;
  url: string | null;
  parent_id: string | null;
  parent_type: string | null;
  icon: string | null;
  last_edited_time: string | null;
  created_time: string | null;
  content_preview: string | null;
  archived: boolean;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToNotionPage(row: any): NotionPageRow {
  return {
    id: row.id,
    page_id: row.page_id,
    title: row.title ?? null,
    url: row.url ?? null,
    parent_id: row.parent_id ?? null,
    parent_type: row.parent_type ?? null,
    icon: row.icon ?? null,
    last_edited_time: row.last_edited_time ?? null,
    created_time: row.created_time ?? null,
    content_preview: row.content_preview ?? null,
    archived: Boolean(row.archived),
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

/**
 * Idempotent batch insert. Notion's page_id is the natural primary key;
 * dedupe_key folds in last_edited_time so re-fetches that contain newer
 * edits create a new row (rather than silently dropping the update).
 *
 * That said, with INSERT OR IGNORE on page_id UNIQUE, the second write
 * for the same page WILL be ignored. If we want "edit-aware re-ingest"
 * later, we'd switch to upsert. For Phase D round 1 we accept the
 * "first-write wins" semantics — same as gmail/gcal.
 */
export function ingestNotionPages(items: NotionPageInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO notion_pages (
       id, page_id, title, url, parent_id, parent_type, icon,
       last_edited_time, created_time, content_preview, archived,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.pageId) continue;
      accepted += 1;
      const id = genId();
      const lastEdited = normalizeToUtcIso(item.lastEditedTime ?? null);
      const createdTime = normalizeToUtcIso(item.createdTime ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? lastEdited ?? createdTime ?? ts;
      const dedupe = item.dedupeKey ?? `notion:page:${item.pageId}:${lastEdited ?? 'noedit'}`;
      const result = insert.run(
        id, item.pageId, item.title ?? null, item.url ?? null,
        item.parentId ?? null, item.parentType ?? null, item.icon ?? null,
        lastEdited, createdTime, item.contentPreview ?? null,
        item.archived ? 1 : 0,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export interface ListNotionOpts {
  since?: string;
  until?: string;
  limit?: number;
  includeArchived?: boolean;
}

export function listNotionPages(opts: ListNotionOpts = {}): NotionPageRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM notion_pages WHERE 1=1'];
  const params: unknown[] = [];
  if (!opts.includeArchived) { parts.push('AND archived = 0'); }
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND last_edited_time >= ?'); params.push(since); }
  if (until) { parts.push('AND last_edited_time <= ?'); params.push(until); }
  parts.push('ORDER BY last_edited_time DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToNotionPage);
}

// ─────── Google Drive files ───────

export interface GdriveFileInput {
  fileId: string;
  name?: string | null;
  mimeType?: string | null;
  modifiedTime?: string | null;
  createdTime?: string | null;
  sizeBytes?: number | null;
  webViewLink?: string | null;
  /** Email addresses or display names of file owners. */
  owners?: string[];
  trashed?: boolean;
  /** ISO; falls back to modifiedTime then createdTime then now. */
  occurredAt?: string;
  dedupeKey?: string;
}

export interface GdriveFileRow {
  id: string;
  file_id: string;
  name: string | null;
  mime_type: string | null;
  modified_time: string | null;
  created_time: string | null;
  size_bytes: number | null;
  web_view_link: string | null;
  owners: string[];
  trashed: boolean;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToGdriveFile(row: any): GdriveFileRow {
  return {
    id: row.id,
    file_id: row.file_id,
    name: row.name ?? null,
    mime_type: row.mime_type ?? null,
    modified_time: row.modified_time ?? null,
    created_time: row.created_time ?? null,
    size_bytes: typeof row.size_bytes === 'number' ? row.size_bytes : null,
    web_view_link: row.web_view_link ?? null,
    owners: parseJsonArray<string>(row.owners_json),
    trashed: Boolean(row.trashed),
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestGdriveFiles(items: GdriveFileInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gdrive_files (
       id, file_id, name, mime_type, modified_time, created_time,
       size_bytes, web_view_link, owners_json, trashed,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.fileId) continue;
      accepted += 1;
      const id = genId();
      const modified = normalizeToUtcIso(item.modifiedTime ?? null);
      const created = normalizeToUtcIso(item.createdTime ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? modified ?? created ?? ts;
      const dedupe = item.dedupeKey ?? `gdrive:file:${item.fileId}:${modified ?? 'nomod'}`;
      const sizeBytes = typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes)
        ? Math.floor(item.sizeBytes) : null;
      const result = insert.run(
        id, item.fileId, item.name ?? null, item.mimeType ?? null,
        modified, created, sizeBytes, item.webViewLink ?? null,
        JSON.stringify(item.owners ?? []),
        item.trashed ? 1 : 0,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export interface ListGdriveOpts {
  since?: string;
  until?: string;
  mimeType?: string;
  limit?: number;
  includeTrashed?: boolean;
}

export function listGdriveFiles(opts: ListGdriveOpts = {}): GdriveFileRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM gdrive_files WHERE 1=1'];
  const params: unknown[] = [];
  if (!opts.includeTrashed) { parts.push('AND trashed = 0'); }
  if (opts.mimeType) { parts.push('AND mime_type = ?'); params.push(opts.mimeType); }
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND modified_time >= ?'); params.push(since); }
  if (until) { parts.push('AND modified_time <= ?'); params.push(until); }
  parts.push('ORDER BY modified_time DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToGdriveFile);
}

// ─────── GitHub issues / PRs ───────

export interface GithubIssueInput {
  issueId: string;
  number?: number | null;
  repoFullName?: string | null;     // 'owner/repo'
  title?: string | null;
  bodyPreview?: string | null;
  state?: string | null;             // 'open' | 'closed'
  htmlUrl?: string | null;
  isPullRequest?: boolean;
  labels?: string[];
  assignees?: string[];
  createdAtRemote?: string | null;
  updatedAtRemote?: string | null;
  /** ISO; falls back to updatedAtRemote then createdAtRemote then now. */
  occurredAt?: string;
  dedupeKey?: string;
}

export interface GithubIssueRow {
  id: string;
  issue_id: string;
  number: number | null;
  repo_full_name: string | null;
  title: string | null;
  body_preview: string | null;
  state: string | null;
  html_url: string | null;
  is_pull_request: boolean;
  labels: string[];
  assignees: string[];
  created_at_remote: string | null;
  updated_at_remote: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToGithubIssue(row: any): GithubIssueRow {
  return {
    id: row.id,
    issue_id: row.issue_id,
    number: typeof row.number === 'number' ? row.number : null,
    repo_full_name: row.repo_full_name ?? null,
    title: row.title ?? null,
    body_preview: row.body_preview ?? null,
    state: row.state ?? null,
    html_url: row.html_url ?? null,
    is_pull_request: Boolean(row.is_pull_request),
    labels: parseJsonArray<string>(row.labels_json),
    assignees: parseJsonArray<string>(row.assignees_json),
    created_at_remote: row.created_at_remote ?? null,
    updated_at_remote: row.updated_at_remote ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestGithubIssues(items: GithubIssueInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO github_issues (
       id, issue_id, number, repo_full_name, title, body_preview, state,
       html_url, is_pull_request, labels_json, assignees_json,
       created_at_remote, updated_at_remote,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.issueId) continue;
      accepted += 1;
      const id = genId();
      const updated = normalizeToUtcIso(item.updatedAtRemote ?? null);
      const created = normalizeToUtcIso(item.createdAtRemote ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? updated ?? created ?? ts;
      // First-write wins: issue_id UNIQUE means a re-fetched issue (even
      // with newer updated_at) gets ignored. Switch to upsert if we ever
      // want edit-aware history. Same trade-off as gmail_messages and
      // notion_pages. The updated_at suffix in dedupe_key is informational
      // only — it doesn't actually open a second slot because issue_id is
      // the binding constraint.
      const dedupe = item.dedupeKey ?? `github:issue:${item.issueId}:${updated ?? 'noupdate'}`;
      const result = insert.run(
        id, item.issueId,
        typeof item.number === 'number' ? item.number : null,
        item.repoFullName ?? null,
        item.title ?? null, item.bodyPreview ?? null,
        item.state ?? null, item.htmlUrl ?? null,
        item.isPullRequest ? 1 : 0,
        JSON.stringify(item.labels ?? []),
        JSON.stringify(item.assignees ?? []),
        created, updated,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export interface ListGithubOpts {
  repoFullName?: string;
  state?: string;
  isPullRequest?: boolean;
  since?: string;
  until?: string;
  limit?: number;
}

export function listGithubIssues(opts: ListGithubOpts = {}): GithubIssueRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM github_issues WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.repoFullName) { parts.push('AND repo_full_name = ?'); params.push(opts.repoFullName); }
  if (opts.state) { parts.push('AND state = ?'); params.push(opts.state); }
  if (typeof opts.isPullRequest === 'boolean') {
    parts.push('AND is_pull_request = ?');
    params.push(opts.isPullRequest ? 1 : 0);
  }
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND updated_at_remote >= ?'); params.push(since); }
  if (until) { parts.push('AND updated_at_remote <= ?'); params.push(until); }
  parts.push('ORDER BY updated_at_remote DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToGithubIssue);
}

// ─────── Outlook messages ───────

export interface OutlookMessageInput {
  messageId: string;
  conversationId?: string | null;
  from?: string | null;
  to?: string[];
  cc?: string[];
  subject?: string | null;
  bodyPreview?: string | null;
  receivedAt?: string | null;
  importance?: string | null;        // 'low' | 'normal' | 'high'
  hasAttachments?: boolean;
  webLink?: string | null;
  /** ISO; falls back to receivedAt then now. */
  occurredAt?: string;
  dedupeKey?: string;
}

export interface OutlookMessageRow {
  id: string;
  message_id: string;
  conversation_id: string | null;
  from_addr: string | null;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  body_preview: string | null;
  received_at: string | null;
  importance: string | null;
  has_attachments: boolean;
  web_link: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToOutlookMessage(row: any): OutlookMessageRow {
  return {
    id: row.id,
    message_id: row.message_id,
    conversation_id: row.conversation_id ?? null,
    from_addr: row.from_addr ?? null,
    to_addrs: parseJsonArray<string>(row.to_addrs_json),
    cc_addrs: parseJsonArray<string>(row.cc_addrs_json),
    subject: row.subject ?? null,
    body_preview: row.body_preview ?? null,
    received_at: row.received_at ?? null,
    importance: row.importance ?? null,
    has_attachments: Boolean(row.has_attachments),
    web_link: row.web_link ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestOutlookMessages(items: OutlookMessageInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO outlook_messages (
       id, message_id, conversation_id, from_addr, to_addrs_json, cc_addrs_json,
       subject, body_preview, received_at, importance, has_attachments, web_link,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.messageId) continue;
      accepted += 1;
      const id = genId();
      const received = normalizeToUtcIso(item.receivedAt ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? received ?? ts;
      const dedupe = item.dedupeKey ?? `outlook:msg:${item.messageId}`;
      const result = insert.run(
        id, item.messageId, item.conversationId ?? null,
        item.from ?? null,
        JSON.stringify(item.to ?? []),
        JSON.stringify(item.cc ?? []),
        item.subject ?? null, item.bodyPreview ?? null,
        received, item.importance ?? null,
        item.hasAttachments ? 1 : 0,
        item.webLink ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export interface ListOutlookOpts {
  conversationId?: string;
  importance?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export function listOutlookMessages(opts: ListOutlookOpts = {}): OutlookMessageRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM outlook_messages WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.conversationId) { parts.push('AND conversation_id = ?'); params.push(opts.conversationId); }
  if (opts.importance) { parts.push('AND importance = ?'); params.push(opts.importance); }
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND received_at >= ?'); params.push(since); }
  if (until) { parts.push('AND received_at <= ?'); params.push(until); }
  parts.push('ORDER BY received_at DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToOutlookMessage);
}

// ─────── Google Docs documents ───────

export interface GdocsDocumentInput {
  documentId: string;
  name?: string | null;
  modifiedTime?: string | null;
  createdTime?: string | null;
  webViewLink?: string | null;
  /** Email or display name of each owner; flattened from {emailAddress|displayName}. */
  owners?: string[];
  lastModifyingUser?: string | null;
  starred?: boolean;
  trashed?: boolean;
  shared?: boolean;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface GdocsDocumentRow {
  id: string;
  document_id: string;
  name: string | null;
  modified_time: string | null;
  created_time: string | null;
  web_view_link: string | null;
  owners: string[];
  last_modifying_user: string | null;
  starred: boolean;
  trashed: boolean;
  shared: boolean;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToGdocsDocument(row: any): GdocsDocumentRow {
  return {
    id: row.id,
    document_id: row.document_id,
    name: row.name ?? null,
    modified_time: row.modified_time ?? null,
    created_time: row.created_time ?? null,
    web_view_link: row.web_view_link ?? null,
    owners: parseJsonArray<string>(row.owners_json),
    last_modifying_user: row.last_modifying_user ?? null,
    starred: Boolean(row.starred),
    trashed: Boolean(row.trashed),
    shared: Boolean(row.shared),
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestGdocsDocuments(items: GdocsDocumentInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gdocs_documents (
       id, document_id, name, modified_time, created_time, web_view_link,
       owners_json, last_modifying_user, starred, trashed, shared,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.documentId) continue;
      accepted += 1;
      const id = genId();
      const modified = normalizeToUtcIso(item.modifiedTime ?? null);
      const created = normalizeToUtcIso(item.createdTime ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? modified ?? created ?? ts;
      const dedupe = item.dedupeKey ?? `gdocs:doc:${item.documentId}:${modified ?? 'nomod'}`;
      const result = insert.run(
        id, item.documentId, item.name ?? null,
        modified, created, item.webViewLink ?? null,
        JSON.stringify(item.owners ?? []),
        item.lastModifyingUser ?? null,
        item.starred ? 1 : 0, item.trashed ? 1 : 0, item.shared ? 1 : 0,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export interface ListGdocsOpts {
  since?: string;
  until?: string;
  limit?: number;
  includeTrashed?: boolean;
}

export function listGdocsDocuments(opts: ListGdocsOpts = {}): GdocsDocumentRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM gdocs_documents WHERE 1=1'];
  const params: unknown[] = [];
  if (!opts.includeTrashed) { parts.push('AND trashed = 0'); }
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND modified_time >= ?'); params.push(since); }
  if (until) { parts.push('AND modified_time <= ?'); params.push(until); }
  parts.push('ORDER BY modified_time DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToGdocsDocument);
}

// ─────── Google Sheets spreadsheets ───────

export interface GsheetsSpreadsheetInput {
  spreadsheetId: string;
  name?: string | null;
  modifiedTime?: string | null;
  createdTime?: string | null;
  webViewLink?: string | null;
  owners?: string[];
  lastModifyingUser?: string | null;
  starred?: boolean;
  trashed?: boolean;
  shared?: boolean;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface GsheetsSpreadsheetRow {
  id: string;
  spreadsheet_id: string;
  name: string | null;
  modified_time: string | null;
  created_time: string | null;
  web_view_link: string | null;
  owners: string[];
  last_modifying_user: string | null;
  starred: boolean;
  trashed: boolean;
  shared: boolean;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToGsheetsSpreadsheet(row: any): GsheetsSpreadsheetRow {
  return {
    id: row.id,
    spreadsheet_id: row.spreadsheet_id,
    name: row.name ?? null,
    modified_time: row.modified_time ?? null,
    created_time: row.created_time ?? null,
    web_view_link: row.web_view_link ?? null,
    owners: parseJsonArray<string>(row.owners_json),
    last_modifying_user: row.last_modifying_user ?? null,
    starred: Boolean(row.starred),
    trashed: Boolean(row.trashed),
    shared: Boolean(row.shared),
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestGsheetsSpreadsheets(items: GsheetsSpreadsheetInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gsheets_spreadsheets (
       id, spreadsheet_id, name, modified_time, created_time, web_view_link,
       owners_json, last_modifying_user, starred, trashed, shared,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.spreadsheetId) continue;
      accepted += 1;
      const id = genId();
      const modified = normalizeToUtcIso(item.modifiedTime ?? null);
      const created = normalizeToUtcIso(item.createdTime ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? modified ?? created ?? ts;
      const dedupe = item.dedupeKey ?? `gsheets:sheet:${item.spreadsheetId}:${modified ?? 'nomod'}`;
      const result = insert.run(
        id, item.spreadsheetId, item.name ?? null,
        modified, created, item.webViewLink ?? null,
        JSON.stringify(item.owners ?? []),
        item.lastModifyingUser ?? null,
        item.starred ? 1 : 0, item.trashed ? 1 : 0, item.shared ? 1 : 0,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listGsheetsSpreadsheets(opts: ListGdocsOpts = {}): GsheetsSpreadsheetRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM gsheets_spreadsheets WHERE 1=1'];
  const params: unknown[] = [];
  if (!opts.includeTrashed) { parts.push('AND trashed = 0'); }
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND modified_time >= ?'); params.push(since); }
  if (until) { parts.push('AND modified_time <= ?'); params.push(until); }
  parts.push('ORDER BY modified_time DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToGsheetsSpreadsheet);
}

// ─────── Stripe invoices ───────

export interface StripeInvoiceInput {
  invoiceId: string;
  number?: string | null;
  status?: string | null;
  amountDue?: number | null;
  amountPaid?: number | null;
  amountRemaining?: number | null;
  currency?: string | null;
  customerId?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  collectionMethod?: string | null;
  /** epoch seconds; mapper converts. */
  createdAtRemote?: string | null;
  dueDate?: string | null;
  hostedInvoiceUrl?: string | null;
  invoicePdf?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface StripeInvoiceRow {
  id: string;
  invoice_id: string;
  number: string | null;
  status: string | null;
  amount_due: number | null;
  amount_paid: number | null;
  amount_remaining: number | null;
  currency: string | null;
  customer_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  collection_method: string | null;
  created_at_remote: string | null;
  due_date: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToStripeInvoice(row: any): StripeInvoiceRow {
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    number: row.number ?? null,
    status: row.status ?? null,
    amount_due: typeof row.amount_due === 'number' ? row.amount_due : null,
    amount_paid: typeof row.amount_paid === 'number' ? row.amount_paid : null,
    amount_remaining: typeof row.amount_remaining === 'number' ? row.amount_remaining : null,
    currency: row.currency ?? null,
    customer_id: row.customer_id ?? null,
    customer_email: row.customer_email ?? null,
    customer_name: row.customer_name ?? null,
    collection_method: row.collection_method ?? null,
    created_at_remote: row.created_at_remote ?? null,
    due_date: row.due_date ?? null,
    hosted_invoice_url: row.hosted_invoice_url ?? null,
    invoice_pdf: row.invoice_pdf ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestStripeInvoices(items: StripeInvoiceInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO stripe_invoices (
       id, invoice_id, number, status,
       amount_due, amount_paid, amount_remaining, currency,
       customer_id, customer_email, customer_name,
       collection_method, created_at_remote, due_date,
       hosted_invoice_url, invoice_pdf,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.invoiceId) continue;
      accepted += 1;
      const id = genId();
      const created = normalizeToUtcIso(item.createdAtRemote ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? created ?? ts;
      const dedupe = item.dedupeKey ?? `stripe:inv:${item.invoiceId}`;
      const result = insert.run(
        id, item.invoiceId, item.number ?? null, item.status ?? null,
        intOrNull(item.amountDue), intOrNull(item.amountPaid), intOrNull(item.amountRemaining),
        item.currency ?? null,
        item.customerId ?? null, item.customerEmail ?? null, item.customerName ?? null,
        item.collectionMethod ?? null, created, item.dueDate ?? null,
        item.hostedInvoiceUrl ?? null, item.invoicePdf ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

function intOrNull(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

export interface ListStripeInvoiceOpts {
  status?: string;
  customerId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export function listStripeInvoices(opts: ListStripeInvoiceOpts = {}): StripeInvoiceRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM stripe_invoices WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.status) { parts.push('AND status = ?'); params.push(opts.status); }
  if (opts.customerId) { parts.push('AND customer_id = ?'); params.push(opts.customerId); }
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND created_at_remote >= ?'); params.push(since); }
  if (until) { parts.push('AND created_at_remote <= ?'); params.push(until); }
  parts.push('ORDER BY created_at_remote DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToStripeInvoice);
}

// ─────── Discord guilds ───────

export interface DiscordGuildInput {
  guildId: string;
  name?: string | null;
  icon?: string | null;
  isOwner?: boolean;
  permissions?: string | null;
  features?: string[];
  approximateMemberCount?: number | null;
  approximatePresenceCount?: number | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface DiscordGuildRow {
  id: string;
  guild_id: string;
  name: string | null;
  icon: string | null;
  is_owner: boolean;
  permissions: string | null;
  features: string[];
  approximate_member_count: number | null;
  approximate_presence_count: number | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToDiscordGuild(row: any): DiscordGuildRow {
  return {
    id: row.id,
    guild_id: row.guild_id,
    name: row.name ?? null,
    icon: row.icon ?? null,
    is_owner: Boolean(row.is_owner),
    permissions: row.permissions ?? null,
    features: parseJsonArray<string>(row.features_json),
    approximate_member_count: typeof row.approximate_member_count === 'number'
      ? row.approximate_member_count : null,
    approximate_presence_count: typeof row.approximate_presence_count === 'number'
      ? row.approximate_presence_count : null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestDiscordGuilds(items: DiscordGuildInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO discord_guilds (
       id, guild_id, name, icon, is_owner, permissions, features_json,
       approximate_member_count, approximate_presence_count,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.guildId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      // Discord membership is mostly stable; dedupe on guild_id alone so
      // re-fetching the same server is a no-op.
      const dedupe = item.dedupeKey ?? `discord:guild:${item.guildId}`;
      const result = insert.run(
        id, item.guildId, item.name ?? null, item.icon ?? null,
        item.isOwner ? 1 : 0, item.permissions ?? null,
        JSON.stringify(item.features ?? []),
        intOrNull(item.approximateMemberCount), intOrNull(item.approximatePresenceCount),
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listDiscordGuilds(opts: { limit?: number } = {}): DiscordGuildRow[] {
  const db = getRawDb();
  return db.prepare(
    `SELECT * FROM discord_guilds ORDER BY name ASC LIMIT ?`,
  ).all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToDiscordGuild);
}

// ─────── Spotify recently played tracks ───────

export interface SpotifyRecentTrackInput {
  trackId: string;
  trackName?: string | null;
  artistNames?: string[];
  albumName?: string | null;
  durationMs?: number | null;
  popularity?: number | null;
  trackUrl?: string | null;
  /** ISO timestamp the track was played; primary order key. */
  playedAt: string;
  contextType?: string | null;
  contextUri?: string | null;
  /** ISO; falls back to playedAt. */
  occurredAt?: string;
  dedupeKey?: string;
}

export interface SpotifyRecentTrackRow {
  id: string;
  track_id: string;
  track_name: string | null;
  artist_names: string[];
  album_name: string | null;
  duration_ms: number | null;
  popularity: number | null;
  track_url: string | null;
  played_at: string;
  context_type: string | null;
  context_uri: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToSpotifyRecentTrack(row: any): SpotifyRecentTrackRow {
  return {
    id: row.id,
    track_id: row.track_id,
    track_name: row.track_name ?? null,
    artist_names: parseJsonArray<string>(row.artist_names_json),
    album_name: row.album_name ?? null,
    duration_ms: typeof row.duration_ms === 'number' ? row.duration_ms : null,
    popularity: typeof row.popularity === 'number' ? row.popularity : null,
    track_url: row.track_url ?? null,
    played_at: row.played_at,
    context_type: row.context_type ?? null,
    context_uri: row.context_uri ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestSpotifyRecentTracks(items: SpotifyRecentTrackInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO spotify_recent_tracks (
       id, track_id, track_name, artist_names_json, album_name,
       duration_ms, popularity, track_url,
       played_at, context_type, context_uri,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.trackId || !item.playedAt) continue;
      accepted += 1;
      const id = genId();
      const playedAt = normalizeToUtcIso(item.playedAt) ?? item.playedAt;
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? playedAt;
      // Track + timestamp = unique play event. Same track replayed gets a
      // new row; same play event re-fetched (init or sync collision)
      // dedupes correctly.
      const dedupe = item.dedupeKey ?? `spotify:recent:${item.trackId}:${playedAt}`;
      const result = insert.run(
        id, item.trackId, item.trackName ?? null,
        JSON.stringify(item.artistNames ?? []),
        item.albumName ?? null,
        intOrNull(item.durationMs ?? null),
        intOrNull(item.popularity ?? null),
        item.trackUrl ?? null,
        playedAt, item.contextType ?? null, item.contextUri ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export interface ListSpotifyRecentOpts {
  since?: string;
  until?: string;
  artistName?: string;
  limit?: number;
}

export function listSpotifyRecentTracks(opts: ListSpotifyRecentOpts = {}): SpotifyRecentTrackRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM spotify_recent_tracks WHERE 1=1'];
  const params: unknown[] = [];
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND played_at >= ?'); params.push(since); }
  if (until) { parts.push('AND played_at <= ?'); params.push(until); }
  if (opts.artistName) {
    // Naive substring match on the JSON-encoded array; good enough for
    // small-N read-side filters and avoids json_each indexing.
    parts.push("AND artist_names_json LIKE ?");
    params.push(`%${opts.artistName.replace(/[%_]/g, (m) => '\\' + m)}%`);
  }
  parts.push('ORDER BY played_at DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToSpotifyRecentTrack);
}

// ─────── Strava activities ───────

export interface StravaActivityInput {
  activityId: string;
  name?: string | null;
  activityType?: string | null;
  distanceMeters?: number | null;
  movingTimeSeconds?: number | null;
  elapsedTimeSeconds?: number | null;
  elevationGainMeters?: number | null;
  startDate?: string | null;
  timezone?: string | null;
  averageSpeedMps?: number | null;
  maxSpeedMps?: number | null;
  averageHeartrate?: number | null;
  maxHeartrate?: number | null;
  kudosCount?: number | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface StravaActivityRow {
  id: string;
  activity_id: string;
  name: string | null;
  activity_type: string | null;
  distance_meters: number | null;
  moving_time_seconds: number | null;
  elapsed_time_seconds: number | null;
  elevation_gain_meters: number | null;
  start_date: string | null;
  timezone: string | null;
  average_speed_mps: number | null;
  max_speed_mps: number | null;
  average_heartrate: number | null;
  max_heartrate: number | null;
  kudos_count: number | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToStravaActivity(row: any): StravaActivityRow {
  return {
    id: row.id,
    activity_id: row.activity_id,
    name: row.name ?? null,
    activity_type: row.activity_type ?? null,
    distance_meters: typeof row.distance_meters === 'number' ? row.distance_meters : null,
    moving_time_seconds: typeof row.moving_time_seconds === 'number' ? row.moving_time_seconds : null,
    elapsed_time_seconds: typeof row.elapsed_time_seconds === 'number' ? row.elapsed_time_seconds : null,
    elevation_gain_meters: typeof row.elevation_gain_meters === 'number' ? row.elevation_gain_meters : null,
    start_date: row.start_date ?? null,
    timezone: row.timezone ?? null,
    average_speed_mps: typeof row.average_speed_mps === 'number' ? row.average_speed_mps : null,
    max_speed_mps: typeof row.max_speed_mps === 'number' ? row.max_speed_mps : null,
    average_heartrate: typeof row.average_heartrate === 'number' ? row.average_heartrate : null,
    max_heartrate: typeof row.max_heartrate === 'number' ? row.max_heartrate : null,
    kudos_count: typeof row.kudos_count === 'number' ? row.kudos_count : null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestStravaActivities(items: StravaActivityInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO strava_activities (
       id, activity_id, name, activity_type,
       distance_meters, moving_time_seconds, elapsed_time_seconds, elevation_gain_meters,
       start_date, timezone, average_speed_mps, max_speed_mps,
       average_heartrate, max_heartrate, kudos_count,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.activityId) continue;
      accepted += 1;
      const id = genId();
      const startDate = normalizeToUtcIso(item.startDate ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? startDate ?? ts;
      const dedupe = item.dedupeKey ?? `strava:activity:${item.activityId}`;
      const result = insert.run(
        id, item.activityId, item.name ?? null, item.activityType ?? null,
        typeof item.distanceMeters === 'number' ? item.distanceMeters : null,
        intOrNull(item.movingTimeSeconds ?? null),
        intOrNull(item.elapsedTimeSeconds ?? null),
        typeof item.elevationGainMeters === 'number' ? item.elevationGainMeters : null,
        startDate, item.timezone ?? null,
        typeof item.averageSpeedMps === 'number' ? item.averageSpeedMps : null,
        typeof item.maxSpeedMps === 'number' ? item.maxSpeedMps : null,
        intOrNull(item.averageHeartrate ?? null),
        intOrNull(item.maxHeartrate ?? null),
        intOrNull(item.kudosCount ?? null),
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listStravaActivities(opts: { since?: string; until?: string; limit?: number } = {}): StravaActivityRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM strava_activities WHERE 1=1'];
  const params: unknown[] = [];
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND start_date >= ?'); params.push(since); }
  if (until) { parts.push('AND start_date <= ?'); params.push(until); }
  parts.push('ORDER BY start_date DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToStravaActivity);
}

// ─────── Todoist tasks ───────

export interface TodoistTaskInput {
  taskId: string;
  content?: string | null;
  description?: string | null;
  projectId?: string | null;
  parentTaskId?: string | null;
  priority?: number | null;
  labels?: string[];
  dueAt?: string | null;
  isCompleted?: boolean;
  createdAtRemote?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface TodoistTaskRow {
  id: string;
  task_id: string;
  content: string | null;
  description: string | null;
  project_id: string | null;
  parent_task_id: string | null;
  priority: number | null;
  labels: string[];
  due_at: string | null;
  is_completed: boolean;
  created_at_remote: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToTodoistTask(row: any): TodoistTaskRow {
  return {
    id: row.id,
    task_id: row.task_id,
    content: row.content ?? null,
    description: row.description ?? null,
    project_id: row.project_id ?? null,
    parent_task_id: row.parent_task_id ?? null,
    priority: typeof row.priority === 'number' ? row.priority : null,
    labels: parseJsonArray<string>(row.labels_json),
    due_at: row.due_at ?? null,
    is_completed: Boolean(row.is_completed),
    created_at_remote: row.created_at_remote ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestTodoistTasks(items: TodoistTaskInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO todoist_tasks (
       id, task_id, content, description, project_id, parent_task_id,
       priority, labels_json, due_at, is_completed, created_at_remote,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.taskId) continue;
      accepted += 1;
      const id = genId();
      const createdRemote = normalizeToUtcIso(item.createdAtRemote ?? null);
      const dueAt = normalizeToUtcIso(item.dueAt ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? createdRemote ?? ts;
      const dedupe = item.dedupeKey ?? `todoist:task:${item.taskId}`;
      const result = insert.run(
        id, item.taskId, item.content ?? null, item.description ?? null,
        item.projectId ?? null, item.parentTaskId ?? null,
        intOrNull(item.priority ?? null),
        JSON.stringify(item.labels ?? []),
        dueAt, item.isCompleted ? 1 : 0, createdRemote,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listTodoistTasks(opts: { projectId?: string; limit?: number } = {}): TodoistTaskRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM todoist_tasks WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.projectId) { parts.push('AND project_id = ?'); params.push(opts.projectId); }
  parts.push('ORDER BY occurred_at DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToTodoistTask);
}

// ─────── YouTube subscriptions ───────

export interface YoutubeSubscriptionInput {
  subscriptionId: string;
  channelId: string;
  channelTitle?: string | null;
  channelDescription?: string | null;
  thumbnailUrl?: string | null;
  subscribedAt?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface YoutubeSubscriptionRow {
  id: string;
  subscription_id: string;
  channel_id: string;
  channel_title: string | null;
  channel_description: string | null;
  thumbnail_url: string | null;
  subscribed_at: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToYoutubeSubscription(row: any): YoutubeSubscriptionRow {
  return {
    id: row.id,
    subscription_id: row.subscription_id,
    channel_id: row.channel_id,
    channel_title: row.channel_title ?? null,
    channel_description: row.channel_description ?? null,
    thumbnail_url: row.thumbnail_url ?? null,
    subscribed_at: row.subscribed_at ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestYoutubeSubscriptions(items: YoutubeSubscriptionInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO youtube_subscriptions (
       id, subscription_id, channel_id, channel_title, channel_description,
       thumbnail_url, subscribed_at,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.subscriptionId || !item.channelId) continue;
      accepted += 1;
      const id = genId();
      const subscribedAt = normalizeToUtcIso(item.subscribedAt ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? subscribedAt ?? ts;
      const dedupe = item.dedupeKey ?? `youtube:sub:${item.subscriptionId}`;
      const result = insert.run(
        id, item.subscriptionId, item.channelId,
        item.channelTitle ?? null, item.channelDescription ?? null,
        item.thumbnailUrl ?? null, subscribedAt,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listYoutubeSubscriptions(opts: { limit?: number } = {}): YoutubeSubscriptionRow[] {
  const db = getRawDb();
  return db.prepare(
    `SELECT * FROM youtube_subscriptions ORDER BY channel_title ASC LIMIT ?`,
  ).all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToYoutubeSubscription);
}

// ─────── Trello boards ───────

export interface TrelloBoardInput {
  boardId: string;
  name?: string | null;
  description?: string | null;
  url?: string | null;
  organizationId?: string | null;
  closed?: boolean;
  starred?: boolean;
  pinned?: boolean;
  lastActivityAt?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface TrelloBoardRow {
  id: string;
  board_id: string;
  name: string | null;
  description: string | null;
  url: string | null;
  organization_id: string | null;
  closed: boolean;
  starred: boolean;
  pinned: boolean;
  last_activity_at: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToTrelloBoard(row: any): TrelloBoardRow {
  return {
    id: row.id,
    board_id: row.board_id,
    name: row.name ?? null,
    description: row.description ?? null,
    url: row.url ?? null,
    organization_id: row.organization_id ?? null,
    closed: Boolean(row.closed),
    starred: Boolean(row.starred),
    pinned: Boolean(row.pinned),
    last_activity_at: row.last_activity_at ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestTrelloBoards(items: TrelloBoardInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO trello_boards (
       id, board_id, name, description, url, organization_id,
       closed, starred, pinned, last_activity_at,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.boardId) continue;
      accepted += 1;
      const id = genId();
      const lastActivityAt = normalizeToUtcIso(item.lastActivityAt ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? lastActivityAt ?? ts;
      const dedupe = item.dedupeKey ?? `trello:board:${item.boardId}`;
      const result = insert.run(
        id, item.boardId, item.name ?? null, item.description ?? null,
        item.url ?? null, item.organizationId ?? null,
        item.closed ? 1 : 0, item.starred ? 1 : 0, item.pinned ? 1 : 0,
        lastActivityAt, occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listTrelloBoards(opts: { includeClosed?: boolean; limit?: number } = {}): TrelloBoardRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM trello_boards WHERE 1=1'];
  if (!opts.includeClosed) parts.push('AND closed = 0');
  parts.push('ORDER BY last_activity_at DESC, name ASC LIMIT ?');
  return db.prepare(parts.join(' ')).all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToTrelloBoard);
}

// ─────── Jira projects ───────

export interface JiraProjectInput {
  projectId: string;
  projectKey?: string | null;
  name?: string | null;
  description?: string | null;
  projectType?: string | null;
  leadName?: string | null;
  url?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface JiraProjectRow {
  id: string;
  project_id: string;
  project_key: string | null;
  name: string | null;
  description: string | null;
  project_type: string | null;
  lead_name: string | null;
  url: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToJiraProject(row: any): JiraProjectRow {
  return {
    id: row.id,
    project_id: row.project_id,
    project_key: row.project_key ?? null,
    name: row.name ?? null,
    description: row.description ?? null,
    project_type: row.project_type ?? null,
    lead_name: row.lead_name ?? null,
    url: row.url ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestJiraProjects(items: JiraProjectInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO jira_projects (
       id, project_id, project_key, name, description, project_type,
       lead_name, url,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.projectId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      const dedupe = item.dedupeKey ?? `jira:project:${item.projectId}`;
      const result = insert.run(
        id, item.projectId, item.projectKey ?? null,
        item.name ?? null, item.description ?? null, item.projectType ?? null,
        item.leadName ?? null, item.url ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listJiraProjects(opts: { limit?: number } = {}): JiraProjectRow[] {
  const db = getRawDb();
  return db.prepare(
    `SELECT * FROM jira_projects ORDER BY name ASC LIMIT ?`,
  ).all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToJiraProject);
}

// ─────── Twitter bookmarks ───────

export interface TwitterBookmarkInput {
  tweetId: string;
  authorUsername?: string | null;
  authorId?: string | null;
  text?: string | null;
  lang?: string | null;
  createdAtRemote?: string | null;
  url?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface TwitterBookmarkRow {
  id: string;
  tweet_id: string;
  author_username: string | null;
  author_id: string | null;
  text: string | null;
  lang: string | null;
  created_at_remote: string | null;
  url: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToTwitterBookmark(row: any): TwitterBookmarkRow {
  return {
    id: row.id,
    tweet_id: row.tweet_id,
    author_username: row.author_username ?? null,
    author_id: row.author_id ?? null,
    text: row.text ?? null,
    lang: row.lang ?? null,
    created_at_remote: row.created_at_remote ?? null,
    url: row.url ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestTwitterBookmarks(items: TwitterBookmarkInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO twitter_bookmarks (
       id, tweet_id, author_username, author_id, text, lang,
       created_at_remote, url,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.tweetId) continue;
      accepted += 1;
      const id = genId();
      const createdRemote = normalizeToUtcIso(item.createdAtRemote ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? createdRemote ?? ts;
      const dedupe = item.dedupeKey ?? `twitter:bookmark:${item.tweetId}`;
      const result = insert.run(
        id, item.tweetId, item.authorUsername ?? null, item.authorId ?? null,
        item.text ?? null, item.lang ?? null,
        createdRemote, item.url ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listTwitterBookmarks(opts: { limit?: number } = {}): TwitterBookmarkRow[] {
  const db = getRawDb();
  return db.prepare(
    `SELECT * FROM twitter_bookmarks ORDER BY created_at_remote DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToTwitterBookmark);
}

// ─────── Calendly scheduled events ───────

export interface CalendlyEventInput {
  eventUri: string;
  name?: string | null;
  status?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  locationType?: string | null;
  locationValue?: string | null;
  invitees?: Array<{ name?: string | null; email?: string | null }>;
  meetingUrl?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface CalendlyEventRow {
  id: string;
  event_uri: string;
  name: string | null;
  status: string | null;
  start_at: string | null;
  end_at: string | null;
  location_type: string | null;
  location_value: string | null;
  invitees: Array<{ name?: string | null; email?: string | null }>;
  meeting_url: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToCalendlyEvent(row: any): CalendlyEventRow {
  return {
    id: row.id,
    event_uri: row.event_uri,
    name: row.name ?? null,
    status: row.status ?? null,
    start_at: row.start_at ?? null,
    end_at: row.end_at ?? null,
    location_type: row.location_type ?? null,
    location_value: row.location_value ?? null,
    invitees: parseJsonArray<{ name?: string | null; email?: string | null }>(row.invitees_json),
    meeting_url: row.meeting_url ?? null,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestCalendlyEvents(items: CalendlyEventInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0;
  let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO calendly_events (
       id, event_uri, name, status, start_at, end_at,
       location_type, location_value, invitees_json, meeting_url,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.eventUri) continue;
      accepted += 1;
      const id = genId();
      const startAt = normalizeToUtcIso(item.startAt ?? null);
      const endAt = normalizeToUtcIso(item.endAt ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? startAt ?? ts;
      const dedupe = item.dedupeKey ?? `calendly:event:${item.eventUri}`;
      const result = insert.run(
        id, item.eventUri, item.name ?? null, item.status ?? null,
        startAt, endAt,
        item.locationType ?? null, item.locationValue ?? null,
        JSON.stringify(item.invitees ?? []),
        item.meetingUrl ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) {
        inserted += 1;
        ids.push(id);
      }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listCalendlyEvents(opts: { since?: string; until?: string; limit?: number } = {}): CalendlyEventRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM calendly_events WHERE 1=1'];
  const params: unknown[] = [];
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND start_at >= ?'); params.push(since); }
  if (until) { parts.push('AND start_at <= ?'); params.push(until); }
  parts.push('ORDER BY start_at DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToCalendlyEvent);
}

// ─────── LinkedIn profile ───────

export interface LinkedinProfileInput {
  linkedinId: string;
  firstName?: string | null;
  lastName?: string | null;
  localizedName?: string | null;
  headline?: string | null;
  vanityName?: string | null;
  pictureUrl?: string | null;
  profileUrl?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface LinkedinProfileRow {
  id: string;
  linkedin_id: string;
  first_name: string | null;
  last_name: string | null;
  localized_name: string | null;
  headline: string | null;
  vanity_name: string | null;
  picture_url: string | null;
  profile_url: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToLinkedinProfile(row: any): LinkedinProfileRow {
  return {
    id: row.id, linkedin_id: row.linkedin_id,
    first_name: row.first_name ?? null, last_name: row.last_name ?? null,
    localized_name: row.localized_name ?? null,
    headline: row.headline ?? null, vanity_name: row.vanity_name ?? null,
    picture_url: row.picture_url ?? null, profile_url: row.profile_url ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestLinkedinProfile(items: LinkedinProfileInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO linkedin_profile (
       id, linkedin_id, first_name, last_name, localized_name,
       headline, vanity_name, picture_url, profile_url,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.linkedinId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      const dedupe = item.dedupeKey ?? `linkedin:profile:${item.linkedinId}`;
      const result = insert.run(
        id, item.linkedinId, item.firstName ?? null, item.lastName ?? null,
        item.localizedName ?? null, item.headline ?? null, item.vanityName ?? null,
        item.pictureUrl ?? null, item.profileUrl ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listLinkedinProfile(): LinkedinProfileRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM linkedin_profile LIMIT 1`).all().map(rowToLinkedinProfile);
}

// ─────── LinkedIn organizations ───────

export interface LinkedinOrganizationInput {
  orgUrn: string;
  orgId?: string | null;
  role?: string | null;
  roleState?: string | null;
  orgName?: string | null;
  orgUrl?: string | null;
  logoUrl?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface LinkedinOrganizationRow {
  id: string;
  org_urn: string;
  org_id: string | null;
  role: string | null;
  role_state: string | null;
  org_name: string | null;
  org_url: string | null;
  logo_url: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToLinkedinOrganization(row: any): LinkedinOrganizationRow {
  return {
    id: row.id, org_urn: row.org_urn,
    org_id: row.org_id ?? null, role: row.role ?? null, role_state: row.role_state ?? null,
    org_name: row.org_name ?? null, org_url: row.org_url ?? null, logo_url: row.logo_url ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestLinkedinOrganizations(items: LinkedinOrganizationInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO linkedin_organizations (
       id, org_urn, org_id, role, role_state, org_name, org_url, logo_url,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.orgUrn) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      // dedupe on (org, role) pair so re-fetching is idempotent but the
      // user holding two different roles at the same org doesn't collapse.
      const dedupe = item.dedupeKey
        ?? `linkedin:org:${item.orgUrn}:${item.role ?? '_'}`;
      const result = insert.run(
        id, item.orgUrn, item.orgId ?? null,
        item.role ?? null, item.roleState ?? null,
        item.orgName ?? null, item.orgUrl ?? null, item.logoUrl ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listLinkedinOrganizations(opts: { limit?: number } = {}): LinkedinOrganizationRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM linkedin_organizations ORDER BY org_name ASC LIMIT ?`)
    .all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToLinkedinOrganization);
}

// ─────── Figma user ───────

export interface FigmaUserInput {
  figmaId: string;
  email?: string | null;
  handle?: string | null;
  imgUrl?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface FigmaUserRow {
  id: string;
  figma_id: string;
  email: string | null;
  handle: string | null;
  img_url: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToFigmaUser(row: any): FigmaUserRow {
  return {
    id: row.id, figma_id: row.figma_id,
    email: row.email ?? null, handle: row.handle ?? null, img_url: row.img_url ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestFigmaUser(items: FigmaUserInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO figma_user (
       id, figma_id, email, handle, img_url,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.figmaId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      const dedupe = item.dedupeKey ?? `figma:user:${item.figmaId}`;
      const result = insert.run(
        id, item.figmaId, item.email ?? null, item.handle ?? null,
        item.imgUrl ?? null, occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listFigmaUser(): FigmaUserRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM figma_user LIMIT 1`).all().map(rowToFigmaUser);
}

// ─────── Zoom user ───────

export interface ZoomUserInput {
  zoomId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  accountType?: number | null;
  roleName?: string | null;
  department?: string | null;
  timezone?: string | null;
  location?: string | null;
  language?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface ZoomUserRow {
  id: string;
  zoom_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  account_type: number | null;
  role_name: string | null;
  department: string | null;
  timezone: string | null;
  location: string | null;
  language: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToZoomUser(row: any): ZoomUserRow {
  return {
    id: row.id, zoom_id: row.zoom_id,
    email: row.email ?? null,
    first_name: row.first_name ?? null, last_name: row.last_name ?? null,
    display_name: row.display_name ?? null,
    account_type: typeof row.account_type === 'number' ? row.account_type : null,
    role_name: row.role_name ?? null, department: row.department ?? null,
    timezone: row.timezone ?? null, location: row.location ?? null,
    language: row.language ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestZoomUser(items: ZoomUserInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO zoom_user (
       id, zoom_id, email, first_name, last_name, display_name,
       account_type, role_name, department, timezone, location, language,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.zoomId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      const dedupe = item.dedupeKey ?? `zoom:user:${item.zoomId}`;
      const result = insert.run(
        id, item.zoomId, item.email ?? null,
        item.firstName ?? null, item.lastName ?? null, item.displayName ?? null,
        intOrNull(item.accountType ?? null),
        item.roleName ?? null, item.department ?? null,
        item.timezone ?? null, item.location ?? null, item.language ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listZoomUser(): ZoomUserRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM zoom_user LIMIT 1`).all().map(rowToZoomUser);
}

// ─────── Zoom marketplace apps ───────

export interface ZoomMarketplaceAppInput {
  appInstallId: string;
  appId?: string | null;
  name?: string | null;
  publisher?: string | null;
  installState?: string | null;
  appType?: string | null;
  installedAt?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface ZoomMarketplaceAppRow {
  id: string;
  app_install_id: string;
  app_id: string | null;
  name: string | null;
  publisher: string | null;
  install_state: string | null;
  app_type: string | null;
  installed_at: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToZoomMarketplaceApp(row: any): ZoomMarketplaceAppRow {
  return {
    id: row.id, app_install_id: row.app_install_id, app_id: row.app_id ?? null,
    name: row.name ?? null, publisher: row.publisher ?? null,
    install_state: row.install_state ?? null, app_type: row.app_type ?? null,
    installed_at: row.installed_at ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestZoomMarketplaceApps(items: ZoomMarketplaceAppInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO zoom_marketplace_apps (
       id, app_install_id, app_id, name, publisher, install_state, app_type, installed_at,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.appInstallId) continue;
      accepted += 1;
      const id = genId();
      const installedAt = normalizeToUtcIso(item.installedAt ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? installedAt ?? ts;
      const dedupe = item.dedupeKey ?? `zoom:app:${item.appInstallId}`;
      const result = insert.run(
        id, item.appInstallId, item.appId ?? null,
        item.name ?? null, item.publisher ?? null,
        item.installState ?? null, item.appType ?? null, installedAt,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listZoomMarketplaceApps(opts: { limit?: number } = {}): ZoomMarketplaceAppRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM zoom_marketplace_apps ORDER BY name ASC LIMIT ?`)
    .all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToZoomMarketplaceApp);
}

// ─────── Dropbox account ───────

export interface DropboxAccountInput {
  accountId: string;
  email?: string | null;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  accountType?: string | null;
  country?: string | null;
  locale?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface DropboxAccountRow {
  id: string;
  account_id: string;
  email: string | null;
  display_name: string | null;
  given_name: string | null;
  surname: string | null;
  account_type: string | null;
  country: string | null;
  locale: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToDropboxAccount(row: any): DropboxAccountRow {
  return {
    id: row.id, account_id: row.account_id,
    email: row.email ?? null, display_name: row.display_name ?? null,
    given_name: row.given_name ?? null, surname: row.surname ?? null,
    account_type: row.account_type ?? null,
    country: row.country ?? null, locale: row.locale ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestDropboxAccount(items: DropboxAccountInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO dropbox_account (
       id, account_id, email, display_name, given_name, surname,
       account_type, country, locale,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.accountId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      const dedupe = item.dedupeKey ?? `dropbox:account:${item.accountId}`;
      const result = insert.run(
        id, item.accountId,
        item.email ?? null, item.displayName ?? null,
        item.givenName ?? null, item.surname ?? null,
        item.accountType ?? null, item.country ?? null, item.locale ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listDropboxAccount(): DropboxAccountRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM dropbox_account LIMIT 1`).all().map(rowToDropboxAccount);
}

// ─────── Dropbox files ───────

export interface DropboxFileInput {
  fileId: string;
  tag?: string | null;
  name?: string | null;
  pathLower?: string | null;
  pathDisplay?: string | null;
  sizeBytes?: number | null;
  serverModified?: string | null;
  clientModified?: string | null;
  rev?: string | null;
  isDownloadable?: boolean;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface DropboxFileRow {
  id: string;
  file_id: string;
  tag: string | null;
  name: string | null;
  path_lower: string | null;
  path_display: string | null;
  size_bytes: number | null;
  server_modified: string | null;
  client_modified: string | null;
  rev: string | null;
  is_downloadable: boolean;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToDropboxFile(row: any): DropboxFileRow {
  return {
    id: row.id, file_id: row.file_id, tag: row.tag ?? null, name: row.name ?? null,
    path_lower: row.path_lower ?? null, path_display: row.path_display ?? null,
    size_bytes: typeof row.size_bytes === 'number' ? row.size_bytes : null,
    server_modified: row.server_modified ?? null,
    client_modified: row.client_modified ?? null,
    rev: row.rev ?? null,
    is_downloadable: Boolean(row.is_downloadable),
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestDropboxFiles(items: DropboxFileInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO dropbox_files (
       id, file_id, tag, name, path_lower, path_display,
       size_bytes, server_modified, client_modified, rev, is_downloadable,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.fileId) continue;
      accepted += 1;
      const id = genId();
      const serverMod = normalizeToUtcIso(item.serverModified ?? null);
      const clientMod = normalizeToUtcIso(item.clientModified ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? serverMod ?? clientMod ?? ts;
      const dedupe = item.dedupeKey ?? `dropbox:file:${item.fileId}`;
      const result = insert.run(
        id, item.fileId, item.tag ?? null, item.name ?? null,
        item.pathLower ?? null, item.pathDisplay ?? null,
        intOrNull(item.sizeBytes ?? null),
        serverMod, clientMod, item.rev ?? null,
        item.isDownloadable === false ? 0 : 1,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listDropboxFiles(opts: { limit?: number } = {}): DropboxFileRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM dropbox_files ORDER BY server_modified DESC LIMIT ?`)
    .all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToDropboxFile);
}

// ─────── Asana workspaces ───────

export interface AsanaWorkspaceInput {
  workspaceGid: string;
  name?: string | null;
  resourceType?: string | null;
  isOrganization?: boolean;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface AsanaWorkspaceRow {
  id: string;
  workspace_gid: string;
  name: string | null;
  resource_type: string | null;
  is_organization: boolean;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToAsanaWorkspace(row: any): AsanaWorkspaceRow {
  return {
    id: row.id, workspace_gid: row.workspace_gid,
    name: row.name ?? null, resource_type: row.resource_type ?? null,
    is_organization: Boolean(row.is_organization),
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestAsanaWorkspaces(items: AsanaWorkspaceInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO asana_workspaces (
       id, workspace_gid, name, resource_type, is_organization,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.workspaceGid) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      const dedupe = item.dedupeKey ?? `asana:workspace:${item.workspaceGid}`;
      const result = insert.run(
        id, item.workspaceGid, item.name ?? null,
        item.resourceType ?? null, item.isOrganization ? 1 : 0,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listAsanaWorkspaces(opts: { limit?: number } = {}): AsanaWorkspaceRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM asana_workspaces ORDER BY name ASC LIMIT ?`)
    .all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToAsanaWorkspace);
}

// ─────── Asana tasks ───────

export interface AsanaTaskInput {
  taskGid: string;
  workspaceGid?: string | null;
  projectGid?: string | null;
  name?: string | null;
  notes?: string | null;
  completed?: boolean;
  assigneeStatus?: string | null;
  dueAt?: string | null;
  dueOn?: string | null;
  modifiedAtRemote?: string | null;
  createdAtRemote?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface AsanaTaskRow {
  id: string;
  task_gid: string;
  workspace_gid: string | null;
  project_gid: string | null;
  name: string | null;
  notes: string | null;
  completed: boolean;
  assignee_status: string | null;
  due_at: string | null;
  due_on: string | null;
  modified_at_remote: string | null;
  created_at_remote: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToAsanaTask(row: any): AsanaTaskRow {
  return {
    id: row.id, task_gid: row.task_gid,
    workspace_gid: row.workspace_gid ?? null, project_gid: row.project_gid ?? null,
    name: row.name ?? null, notes: row.notes ?? null,
    completed: Boolean(row.completed),
    assignee_status: row.assignee_status ?? null,
    due_at: row.due_at ?? null, due_on: row.due_on ?? null,
    modified_at_remote: row.modified_at_remote ?? null,
    created_at_remote: row.created_at_remote ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestAsanaTasks(items: AsanaTaskInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO asana_tasks (
       id, task_gid, workspace_gid, project_gid, name, notes,
       completed, assignee_status, due_at, due_on,
       modified_at_remote, created_at_remote,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.taskGid) continue;
      accepted += 1;
      const id = genId();
      const dueAt = normalizeToUtcIso(item.dueAt ?? null);
      const modified = normalizeToUtcIso(item.modifiedAtRemote ?? null);
      const created = normalizeToUtcIso(item.createdAtRemote ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? modified ?? created ?? ts;
      const dedupe = item.dedupeKey ?? `asana:task:${item.taskGid}`;
      const result = insert.run(
        id, item.taskGid, item.workspaceGid ?? null, item.projectGid ?? null,
        item.name ?? null, item.notes ?? null,
        item.completed ? 1 : 0, item.assigneeStatus ?? null,
        dueAt, item.dueOn ?? null,
        modified, created,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listAsanaTasks(opts: { limit?: number; workspaceGid?: string } = {}): AsanaTaskRow[] {
  const db = getRawDb();
  const parts = ['SELECT * FROM asana_tasks WHERE 1=1'];
  const params: unknown[] = [];
  if (opts.workspaceGid) { parts.push('AND workspace_gid = ?'); params.push(opts.workspaceGid); }
  parts.push('ORDER BY modified_at_remote DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params).map(rowToAsanaTask);
}

// ─────── HubSpot contacts ───────

export interface HubspotContactInput {
  contactId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  jobtitle?: string | null;
  lifecycleStage?: string | null;
  leadStatus?: string | null;
  createdAtRemote?: string | null;
  modifiedAtRemote?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface HubspotContactRow {
  id: string;
  contact_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  jobtitle: string | null;
  lifecycle_stage: string | null;
  lead_status: string | null;
  created_at_remote: string | null;
  modified_at_remote: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToHubspotContact(row: any): HubspotContactRow {
  return {
    id: row.id, contact_id: row.contact_id,
    email: row.email ?? null,
    first_name: row.first_name ?? null, last_name: row.last_name ?? null,
    company: row.company ?? null, jobtitle: row.jobtitle ?? null,
    lifecycle_stage: row.lifecycle_stage ?? null, lead_status: row.lead_status ?? null,
    created_at_remote: row.created_at_remote ?? null,
    modified_at_remote: row.modified_at_remote ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestHubspotContacts(items: HubspotContactInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO hubspot_contacts (
       id, contact_id, email, first_name, last_name, company, jobtitle,
       lifecycle_stage, lead_status, created_at_remote, modified_at_remote,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.contactId) continue;
      accepted += 1;
      const id = genId();
      const created = normalizeToUtcIso(item.createdAtRemote ?? null);
      const modified = normalizeToUtcIso(item.modifiedAtRemote ?? null);
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? modified ?? created ?? ts;
      const dedupe = item.dedupeKey ?? `hubspot:contact:${item.contactId}`;
      const result = insert.run(
        id, item.contactId, item.email ?? null,
        item.firstName ?? null, item.lastName ?? null,
        item.company ?? null, item.jobtitle ?? null,
        item.lifecycleStage ?? null, item.leadStatus ?? null,
        created, modified,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listHubspotContacts(opts: { limit?: number } = {}): HubspotContactRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM hubspot_contacts ORDER BY modified_at_remote DESC LIMIT ?`)
    .all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToHubspotContact);
}

// ─────── ClickUp user ───────

export interface ClickupUserInput {
  clickupId: string;
  username?: string | null;
  email?: string | null;
  color?: string | null;
  profilePicture?: string | null;
  timezone?: string | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface ClickupUserRow {
  id: string;
  clickup_id: string;
  username: string | null;
  email: string | null;
  color: string | null;
  profile_picture: string | null;
  timezone: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToClickupUser(row: any): ClickupUserRow {
  return {
    id: row.id, clickup_id: row.clickup_id,
    username: row.username ?? null, email: row.email ?? null,
    color: row.color ?? null, profile_picture: row.profile_picture ?? null,
    timezone: row.timezone ?? null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestClickupUser(items: ClickupUserInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO clickup_user (
       id, clickup_id, username, email, color, profile_picture, timezone,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.clickupId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      const dedupe = item.dedupeKey ?? `clickup:user:${item.clickupId}`;
      const result = insert.run(
        id, item.clickupId, item.username ?? null, item.email ?? null,
        item.color ?? null, item.profilePicture ?? null, item.timezone ?? null,
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listClickupUser(): ClickupUserRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM clickup_user LIMIT 1`).all().map(rowToClickupUser);
}

// ─────── ClickUp workspaces ───────

export interface ClickupWorkspaceInput {
  workspaceId: string;
  name?: string | null;
  color?: string | null;
  avatar?: string | null;
  membersCount?: number | null;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface ClickupWorkspaceRow {
  id: string;
  workspace_id: string;
  name: string | null;
  color: string | null;
  avatar: string | null;
  members_count: number | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rowToClickupWorkspace(row: any): ClickupWorkspaceRow {
  return {
    id: row.id, workspace_id: row.workspace_id,
    name: row.name ?? null, color: row.color ?? null, avatar: row.avatar ?? null,
    members_count: typeof row.members_count === 'number' ? row.members_count : null,
    occurred_at: row.occurred_at, ingested_at: row.ingested_at,
    dedupe_key: row.dedupe_key ?? null,
    reference_count: typeof row.reference_count === 'number' ? row.reference_count : 0,
    last_referenced_at: row.last_referenced_at ?? null,
    referenced_by_runs: parseJsonArray<string>(row.referenced_by_runs),
  };
}

export function ingestClickupWorkspaces(items: ClickupWorkspaceInput[]): IngestResult {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
  const db = getRawDb();
  const ts = nowIso();
  const ids: string[] = [];
  let inserted = 0; let accepted = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO clickup_workspaces (
       id, workspace_id, name, color, avatar, members_count,
       occurred_at, ingested_at, dedupe_key,
       reference_count, last_referenced_at, referenced_by_runs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, '[]')`,
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      if (!item.workspaceId) continue;
      accepted += 1;
      const id = genId();
      const occurredAt = normalizeToUtcIso(item.occurredAt ?? null) ?? ts;
      const dedupe = item.dedupeKey ?? `clickup:workspace:${item.workspaceId}`;
      const result = insert.run(
        id, item.workspaceId, item.name ?? null,
        item.color ?? null, item.avatar ?? null,
        intOrNull(item.membersCount ?? null),
        occurredAt, ts, dedupe,
      );
      if (result.changes > 0) { inserted += 1; ids.push(id); }
    }
  });
  tx();
  return { accepted, inserted, ignored: accepted - inserted, ids };
}

export function listClickupWorkspaces(opts: { limit?: number } = {}): ClickupWorkspaceRow[] {
  const db = getRawDb();
  return db.prepare(`SELECT * FROM clickup_workspaces ORDER BY name ASC LIMIT ?`)
    .all(Math.max(1, Math.min(opts.limit ?? 50, 500))).map(rowToClickupWorkspace);
}

// ─────── Reference tracking — uniform across every raw table ───────

const REFERENCE_TABLES = new Set([
  'gmail_messages',
  'gcal_events',
  'device_apps_snapshot',
  'device_contacts_snapshot',
  'device_health_observations',
  // Phase D round 1
  'slack_messages',
  'notion_pages',
  'gdrive_files',
  // Phase D round 2
  'github_issues',
  'outlook_messages',
  // Phase D round 3
  'gdocs_documents',
  'gsheets_spreadsheets',
  'stripe_invoices',
  'discord_guilds',
  // Phase D round 4
  'spotify_recent_tracks',
  'strava_activities',
  'todoist_tasks',
  'youtube_subscriptions',
  'trello_boards',
  'jira_projects',
  'twitter_bookmarks',
  'calendly_events',
  // Phase D round 5
  'linkedin_profile',
  'linkedin_organizations',
  'figma_user',
  'zoom_user',
  'zoom_marketplace_apps',
  'dropbox_account',
  'dropbox_files',
  'asana_workspaces',
  'asana_tasks',
  'hubspot_contacts',
  'clickup_user',
  'clickup_workspaces',
]);

/**
 * Generic list of any registered raw table. Used by the HTTP `/raw/<table>`
 * dispatcher and the Profile page workbench.
 *
 * All raw tables share the `occurred_at` ISO column, so since/until filtering
 * works uniformly. The table name is whitelisted via REFERENCE_TABLES to
 * prevent SQL injection (the table name is interpolated into the query
 * string because SQLite doesn't bind table identifiers).
 */
export function listRawTable(
  table: string,
  opts: { since?: string; until?: string; limit?: number } = {},
): Record<string, unknown>[] {
  if (!REFERENCE_TABLES.has(table)) {
    throw new Error(`listRawTable: unknown raw table ${table}`);
  }
  const db = getRawDb();
  const parts = [`SELECT * FROM ${table} WHERE 1=1`];
  const params: unknown[] = [];
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND occurred_at >= ?'); params.push(since); }
  if (until) { parts.push('AND occurred_at <= ?'); params.push(until); }
  parts.push('ORDER BY occurred_at DESC LIMIT ?');
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
  return db.prepare(parts.join(' ')).all(...params) as Record<string, unknown>[];
}

export function countRawTable(
  table: string,
  opts: { since?: string; until?: string } = {},
): number {
  if (!REFERENCE_TABLES.has(table)) {
    throw new Error(`countRawTable: unknown raw table ${table}`);
  }
  const db = getRawDb();
  const parts = [`SELECT COUNT(*) AS total FROM ${table} WHERE 1=1`];
  const params: unknown[] = [];
  const since = normalizeToUtcIso(opts.since);
  const until = normalizeToUtcIso(opts.until);
  if (since) { parts.push('AND occurred_at >= ?'); params.push(since); }
  if (until) { parts.push('AND occurred_at <= ?'); params.push(until); }
  const row = db.prepare(parts.join(' ')).get(...params) as { total?: number } | undefined;
  return row?.total ?? 0;
}

/** Snake_case names of every raw table that the generic `/raw/<table>`
 * dispatcher will accept. Tracks REFERENCE_TABLES; exported so the HTTP
 * route layer doesn't need to duplicate this list. */
export function listRegisteredRawTables(): string[] {
  return Array.from(REFERENCE_TABLES).sort();
}

/**
 * Bump reference_count + dedup-append runId to referenced_by_runs (cap 10)
 * for the given raw rows. Throws if `table` is not a known raw table.
 */
export function markRawReferenced(
  table: string,
  ids: string[],
  runId: string,
): number {
  if (!REFERENCE_TABLES.has(table)) {
    throw new Error(`markRawReferenced: unknown raw table ${table}`);
  }
  if (!runId || ids.length === 0) return 0;
  const db = getRawDb();
  const ts = nowIso();
  let updated = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const row = db.prepare(
        `SELECT referenced_by_runs FROM ${table} WHERE id = ?`,
      ).get(id) as { referenced_by_runs?: string } | undefined;
      if (!row) continue;
      const existing = parseJsonArray<string>(row.referenced_by_runs);
      const nextRuns = existing.includes(runId)
        ? existing
        : [...existing.slice(-(REFERENCED_BY_RUNS_CAP - 1)), runId];
      db.prepare(
        `UPDATE ${table}
         SET reference_count = reference_count + 1,
             last_referenced_at = ?,
             referenced_by_runs = ?
         WHERE id = ?`,
      ).run(ts, JSON.stringify(nextRuns), id);
      updated += 1;
    }
  });
  tx();
  return updated;
}
