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
      // Include updated time in dedupe so a refetched-but-edited issue
      // would dodge dedupe — same trade-off as notion_pages.
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

// ─────── Reference tracking — uniform across every raw table ───────

const REFERENCE_TABLES = new Set([
  'gmail_messages',
  'gcal_events',
  'device_apps_snapshot',
  'device_contacts_snapshot',
  // Phase D round 1
  'slack_messages',
  'notion_pages',
  'gdrive_files',
  // Phase D round 2
  'github_issues',
  'outlook_messages',
]);

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
