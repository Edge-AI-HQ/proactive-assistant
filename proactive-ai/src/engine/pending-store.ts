import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

export type PendingSource = 'world' | 'personal';
export type PendingStatus = 'pending' | 'processed';
export type AutoLoopStatus = 'success' | 'error';

export interface PendingItem {
  id: string;
  source: PendingSource;
  kind: string;
  createdAt: string;
  availableAt: string;
  status: PendingStatus;
  processedAt: string | null;
  payload: Record<string, unknown>;
}

export interface PendingStore {
  worldCursorUpdatedAt: string | null;
  personalSnapshotHash: string | null;
  items: PendingItem[];
}

export interface AutoLoopStateRecord {
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: AutoLoopStatus | null;
}

let schemaReady = false;
let migrated = false;

function getPinDbPath(): string {
  const home = process.env['HOME'] ?? '/tmp';
  const dataRoot = process.env['PIN_DATA_ROOT'] ?? resolve(home, '.pin');
  const dataDir = resolve(dataRoot, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return resolve(dataDir, 'pin.db');
}

function getLegacyPendingPath(): string {
  const home = process.env['HOME'] ?? '/tmp';
  return resolve(home, '.openclaw-proactive-ai', 'proactive-ai', 'pending.json');
}

function openDb(): Database.Database {
  const db = new Database(getPinDbPath());
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database.Database): void {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_ingest_cursor (
      source TEXT PRIMARY KEY,
      cursor TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proactive_pending (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processed')),
      processed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_pending_status_available
      ON proactive_pending(status, available_at);

    CREATE TABLE IF NOT EXISTS proactive_loop_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proactive_context_runs (
      run_token TEXT PRIMARY KEY,
      item_ids_json TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'committed', 'expired')),
      committed_at TEXT
    );
  `);
  schemaReady = true;
  migrateFromLegacyJson(db);
}

function migrateFromLegacyJson(db: Database.Database): void {
  if (migrated) return;
  migrated = true;

  const legacyPath = getLegacyPendingPath();
  if (!existsSync(legacyPath)) return;

  const pendingCountRow = db.prepare('SELECT COUNT(1) AS c FROM proactive_pending').get() as { c: number };
  const cursorCountRow = db.prepare('SELECT COUNT(1) AS c FROM proactive_ingest_cursor').get() as { c: number };
  if ((pendingCountRow.c ?? 0) > 0 || (cursorCountRow.c ?? 0) > 0) return;

  try {
    const raw = readFileSync(legacyPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PendingStore>;
    const items = Array.isArray(parsed.items) ? parsed.items as PendingItem[] : [];
    const worldCursor = parsed.worldCursorUpdatedAt ?? null;
    const personalCursor = parsed.personalSnapshotHash ?? null;

    const insertItem = db.prepare(`
      INSERT OR IGNORE INTO proactive_pending
      (id, source, kind, payload_json, created_at, available_at, status, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertCursor = db.prepare(`
      INSERT INTO proactive_ingest_cursor(source, cursor, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at
    `);
    const nowIso = new Date().toISOString();

    const tx = db.transaction(() => {
      for (const item of items) {
        insertItem.run(
          item.id,
          item.source,
          item.kind,
          JSON.stringify(item.payload ?? {}),
          item.createdAt,
          item.availableAt,
          item.status,
          item.processedAt ?? null,
        );
      }
      if (typeof worldCursor === 'string') upsertCursor.run('world', worldCursor, nowIso);
      if (typeof personalCursor === 'string') upsertCursor.run('personal', personalCursor, nowIso);
    });
    tx();
    try {
      unlinkSync(legacyPath);
    } catch {
      // no-op
    }
  } catch {
    // best effort migration: ignore malformed legacy content
  }
}

function readCursor(db: Database.Database, source: PendingSource): string | null {
  const row = db
    .prepare('SELECT cursor FROM proactive_ingest_cursor WHERE source = ? LIMIT 1')
    .get(source) as { cursor: string | null } | undefined;
  return row?.cursor ?? null;
}

function readLoopStateValue(db: Database.Database, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM proactive_loop_state WHERE key = ? LIMIT 1')
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

function writeLoopStateValue(db: Database.Database, key: string, value: string | null): void {
  db
    .prepare(`
      INSERT INTO proactive_loop_state(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `)
    .run(key, value, new Date().toISOString());
}

function readPendingStoreFromDb(db: Database.Database, limit = 500): PendingStore {
  const rows = db
    .prepare(`
      SELECT id, source, kind, payload_json, created_at, available_at, status, processed_at
      FROM proactive_pending
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      id: string;
      source: string;
      kind: string;
      payload_json: string;
      created_at: string;
      available_at: string;
      status: string;
      processed_at: string | null;
    }>;

  const items = rows.map((row) => ({
    id: row.id,
    source: row.source as PendingSource,
    kind: row.kind,
    createdAt: row.created_at,
    availableAt: row.available_at,
    status: row.status as PendingStatus,
    processedAt: row.processed_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }));

  return {
    worldCursorUpdatedAt: readCursor(db, 'world'),
    personalSnapshotHash: readCursor(db, 'personal'),
    items,
  };
}

export function loadPendingStore(limit = 500): PendingStore {
  const db = openDb();
  try {
    return readPendingStoreFromDb(db, limit);
  } finally {
    db.close();
  }
}

export function loadAutoLoopState(): AutoLoopStateRecord {
  const db = openDb();
  try {
    const lastStatus = readLoopStateValue(db, 'last_status');
    return {
      lastStartedAt: readLoopStateValue(db, 'last_started_at'),
      lastFinishedAt: readLoopStateValue(db, 'last_finished_at'),
      lastStatus: lastStatus === 'success' || lastStatus === 'error' ? lastStatus : null,
    };
  } finally {
    db.close();
  }
}

export function saveAutoLoopState(input: Partial<AutoLoopStateRecord>): AutoLoopStateRecord {
  const db = openDb();
  try {
    const current = {
      lastStartedAt: readLoopStateValue(db, 'last_started_at'),
      lastFinishedAt: readLoopStateValue(db, 'last_finished_at'),
      lastStatus: readLoopStateValue(db, 'last_status'),
    };
    const nextLastStatus =
      input.lastStatus === 'success' || input.lastStatus === 'error'
        ? input.lastStatus
        : input.lastStatus === null
          ? null
          : current.lastStatus;
    const next: AutoLoopStateRecord = {
      lastStartedAt: input.lastStartedAt === undefined ? current.lastStartedAt : input.lastStartedAt,
      lastFinishedAt: input.lastFinishedAt === undefined ? current.lastFinishedAt : input.lastFinishedAt,
      lastStatus: nextLastStatus === 'success' || nextLastStatus === 'error' ? nextLastStatus : null,
    };

    const tx = db.transaction(() => {
      writeLoopStateValue(db, 'last_started_at', next.lastStartedAt);
      writeLoopStateValue(db, 'last_finished_at', next.lastFinishedAt);
      writeLoopStateValue(db, 'last_status', next.lastStatus);
    });
    tx();
    return next;
  } finally {
    db.close();
  }
}
