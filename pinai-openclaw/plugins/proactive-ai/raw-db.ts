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

const REFERENCE_TABLES = new Set([
  'gmail_messages',
  'gcal_events',
  'device_apps_snapshot',
  'device_contacts_snapshot',
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
