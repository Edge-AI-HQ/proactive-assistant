import type { PersonalSignalInput } from "@/lib/devices";
import { stableHash, stripTranscriptSegmentLabels } from "./timeline/utils";

export type OutboxKind = "memory" | "sqlite";
export type OutboxStatus = "pending" | "synced" | "failed";

export interface OutboxRecord {
  id: string;
  item: PersonalSignalInput;
  dedupeKey: string;
  status: OutboxStatus;
  attemptCount: number;
  lastError: string | null;
  nextRetryAt: number | null;
  insertedAt: number;
  updatedAt: number;
  syncedAt: number | null;
  syncedOwnerUserId: string | null;
  syncedBackendUrl: string | null;
}

export interface OutboxStore {
  readonly kind: OutboxKind;
  enqueue(items: PersonalSignalInput[]): Promise<number>;
  pending(
    limit: number,
    now?: number,
    ownerUserId?: string | null,
    backendUrl?: string | null,
  ): Promise<OutboxRecord[]>;
  markSynced(
    ids: string[],
    at?: number,
    ownerUserId?: string | null,
    backendUrl?: string | null,
  ): Promise<void>;
  markFailed(ids: string[], error: string, nextRetryAt: number): Promise<void>;
  prune(now?: number): Promise<number>;
  count(ownerUserId?: string | null, backendUrl?: string | null): Promise<number>;
}

const SYNCED_RETENTION_MS = 86_400_000;
const DEFAULT_TTL_MS = 7 * 86_400_000;

export class MemoryOutboxStore implements OutboxStore {
  readonly kind = "memory" as const;
  private records: OutboxRecord[] = [];

  async enqueue(items: PersonalSignalInput[]): Promise<number> {
    let inserted = 0;
    const now = Date.now();
    for (const item of items) {
      const record = makeRecord(item, now);
      const existingIndex = this.records.findIndex((row) => row.dedupeKey === record.dedupeKey);
      if (existingIndex < 0) {
        this.records.push(record);
        inserted += 1;
        continue;
      }
      const existing = this.records[existingIndex];
      if (!existing) continue;
      if (!shouldReplaceExistingOutboxRecord(existing, record)) {
        continue;
      }
      this.records[existingIndex] = replaceExistingOutboxRecord(existing, record, now);
      inserted += 1;
    }
    return inserted;
  }

  async pending(
    limit: number,
    now = Date.now(),
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<OutboxRecord[]> {
    return this.records
      .filter((row) => isReady(row, now, ownerUserId, backendUrl))
      .sort(compareRecords)
      .slice(0, limit)
      .map(cloneRecord);
  }

  async markSynced(
    ids: string[],
    at = Date.now(),
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const row of this.records) {
      if (!idSet.has(row.id)) continue;
      row.status = "synced";
      row.syncedAt = at;
      row.syncedOwnerUserId = ownerUserId;
      row.syncedBackendUrl = backendUrl;
      row.nextRetryAt = null;
      row.lastError = null;
      row.updatedAt = at;
    }
  }

  async markFailed(ids: string[], error: string, nextRetryAt: number): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const row of this.records) {
      if (!idSet.has(row.id)) continue;
      row.status = "failed";
      row.attemptCount += 1;
      row.lastError = error;
      row.nextRetryAt = nextRetryAt;
      row.updatedAt = Date.now();
    }
  }

  async prune(now = Date.now()): Promise<number> {
    const before = this.records.length;
    this.records = this.records.filter((row) => {
      if (row.status === "synced") {
        return row.syncedAt === null || row.syncedAt >= now - SYNCED_RETENTION_MS;
      }
      return recordExpiresAt(row) > now;
    });
    return before - this.records.length;
  }

  async count(
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<number> {
    return this.records.filter((row) => isUnsettledForScope(row, ownerUserId, backendUrl)).length;
  }
}

function makeRecord(item: PersonalSignalInput, now: number): OutboxRecord {
  const id = item.id ?? generateId();
  const occurredAt = item.occurred_at ?? new Date(now).toISOString();
  const normalized: PersonalSignalInput = {
    ...item,
    id,
    occurred_at: occurredAt,
  };
  const dedupeKey = normalized.dedupe_key ?? `${normalized.kind}:${id}`;
  normalized.dedupe_key = dedupeKey;
  const canonicalDedupeKey = transcriptCandidateDedupeKey(normalized) ?? dedupeKey;
  normalized.dedupe_key = canonicalDedupeKey;
  const itemForRecord = normalizeTranscriptCandidateSignal(normalized);

  return {
    id,
    item: itemForRecord,
    dedupeKey: canonicalDedupeKey,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    nextRetryAt: null,
    insertedAt: now,
    updatedAt: now,
    syncedAt: null,
    syncedOwnerUserId: null,
    syncedBackendUrl: null,
  };
}

function normalizeTranscriptCandidateSignal(item: PersonalSignalInput): PersonalSignalInput {
  if (!isTranscriptCandidateWindow(item)) return item;
  const payload = item.payload ?? {};
  const compactContext = cleanPayloadString(payload.compact_context);
  const cleanSummary = stripTranscriptSegmentLabels(item.summary);
  const cleanCompactContext = compactContext
    ? stripTranscriptSegmentLabels(compactContext)
    : null;
  if (cleanSummary === item.summary && cleanCompactContext === compactContext) {
    return item;
  }
  const hashSource = cleanCompactContext || cleanSummary;
  return {
    ...item,
    summary: cleanSummary || item.summary,
    payload: {
      ...payload,
      ...(cleanCompactContext ? { compact_context: cleanCompactContext } : {}),
      ...(hashSource ? { content_hash: stableHash(hashSource) } : {}),
    },
  };
}

function shouldReplaceExistingOutboxRecord(
  existing: OutboxRecord,
  incoming: OutboxRecord,
): boolean {
  if (!isTranscriptCandidateWindow(existing.item) || !isTranscriptCandidateWindow(incoming.item)) {
    return false;
  }
  const existingFreshness = candidateWindowFreshness(existing.item);
  const incomingFreshness = candidateWindowFreshness(incoming.item);
  if (incomingFreshness.rawRefCount > existingFreshness.rawRefCount) return true;
  if (incomingFreshness.rawRefCount < existingFreshness.rawRefCount) return false;
  return incomingFreshness.contentHash !== existingFreshness.contentHash;
}

function replaceExistingOutboxRecord(
  existing: OutboxRecord,
  incoming: OutboxRecord,
  now: number,
): OutboxRecord {
  return {
    ...existing,
    item: incoming.item,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    nextRetryAt: null,
    updatedAt: now,
    syncedAt: null,
    syncedOwnerUserId: null,
    syncedBackendUrl: null,
  };
}

function isTranscriptCandidateWindow(item: PersonalSignalInput): boolean {
  return transcriptCandidateDedupeKey(item) !== null;
}

function transcriptCandidateDedupeKey(item: PersonalSignalInput): string | null {
  if (item.kind !== "ambient.candidate_window") return null;
  const payload = item.payload ?? {};
  if (payload.window_type !== "transcript_session") return null;
  const localDate = cleanPayloadString(payload.local_date);
  const localWindowId = cleanPayloadString(payload.local_window_id);
  if (!localDate || !localWindowId) return null;
  return `ambient:candidate_window:${localDate}:transcript_session:${localWindowId}`;
}

function candidateWindowFreshness(item: PersonalSignalInput): {
  rawRefCount: number;
  contentHash: string | null;
} {
  const payload = item.payload ?? {};
  return {
    rawRefCount: nonNegativeInteger(payload.raw_ref_count),
    contentHash: cleanPayloadString(payload.content_hash),
  };
}

function cleanPayloadString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}

function isReady(
  row: OutboxRecord,
  now: number,
  ownerUserId: string | null,
  backendUrl: string | null,
): boolean {
  if (!isUnsettledForScope(row, ownerUserId, backendUrl)) return false;
  if (recordAvailableAt(row) > now) return false;
  if (recordExpiresAt(row) <= now) return false;
  return row.nextRetryAt === null || row.nextRetryAt <= now;
}

function isUnsettledForScope(
  row: OutboxRecord,
  ownerUserId: string | null,
  backendUrl: string | null,
): boolean {
  if (row.status !== "synced") return true;
  if (ownerUserId && row.syncedOwnerUserId !== ownerUserId) return true;
  if (backendUrl && row.syncedBackendUrl !== backendUrl) return true;
  return false;
}

function compareRecords(a: OutboxRecord, b: OutboxRecord): number {
  const availableDelta = recordAvailableAt(a) - recordAvailableAt(b);
  if (availableDelta !== 0) return availableDelta;
  return recordOccurredAt(a) - recordOccurredAt(b);
}

function recordAvailableAt(row: OutboxRecord): number {
  return parseTime(row.item.available_at) ?? recordOccurredAt(row);
}

function recordOccurredAt(row: OutboxRecord): number {
  return parseTime(row.item.occurred_at) ?? row.insertedAt;
}

function recordExpiresAt(row: OutboxRecord): number {
  return parseTime(row.item.expires_at) ?? row.insertedAt + DEFAULT_TTL_MS;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function cloneRecord(record: OutboxRecord): OutboxRecord {
  return {
    ...record,
    item: {
      ...record.item,
      payload: record.item.payload ? { ...record.item.payload } : undefined,
    },
  };
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `outbox-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}


// ── SQLite-backed outbox (mobile only) ─────────────────────────────────
//
// MemoryOutboxStore loses every queued event on app kill — unacceptable
// for mobile where the OS may suspend / kill the app at any time. The
// SQLite store persists across restarts using @capacitor-community/sqlite.
//
// Schema:
//   ambient_outbox(
//     id TEXT PRIMARY KEY,
//     item TEXT NOT NULL,           -- JSON-encoded PersonalSignalInput
//     dedupe_key TEXT NOT NULL UNIQUE,
//     status TEXT NOT NULL,         -- 'pending' | 'synced' | 'failed'
//     attempt_count INTEGER NOT NULL DEFAULT 0,
//     last_error TEXT,
//     next_retry_at INTEGER,
//     inserted_at INTEGER NOT NULL,
//     updated_at INTEGER NOT NULL,
//     synced_at INTEGER,
//     synced_owner_user_id TEXT,
//     synced_backend_url TEXT
//   );
//   CREATE INDEX IF NOT EXISTS ix_ambient_outbox_pending
//     ON ambient_outbox (status, next_retry_at);

interface SqliteConnection {
  open(): Promise<void>;
  isDBOpen?(): Promise<{ result?: boolean }>;
  execute(sql: string): Promise<unknown>;
  run(sql: string, values?: unknown[]): Promise<{ changes?: { changes?: number } }>;
  query(sql: string, values?: unknown[]): Promise<{ values?: Record<string, unknown>[] }>;
}

interface SqliteConnectionFactory {
  createConnection(
    dbName: string, encrypted: boolean, mode: string, version: number,
    readonly: boolean,
  ): Promise<SqliteConnection>;
  retrieveConnection(
    dbName: string, readonly: boolean,
  ): Promise<SqliteConnection>;
  isConnection(
    dbName: string, readonly: boolean,
  ): Promise<{ result?: boolean }>;
  checkConnectionsConsistency?(opts: {
    dbNames: string[]; openModes: string[];
  }): Promise<{ result?: boolean }>;
  closeConnection?(dbName: string, readonly: boolean): Promise<void>;
}

interface SqliteModule {
  CapacitorSQLite?: unknown;
  SQLiteConnection?: new (sqlite: unknown) => SqliteConnectionFactory;
}

const DB_NAME = "pin_ambient_outbox";
let sharedSqliteConnection: SqliteConnection | null = null;
let sqliteConnectionOpenPromise: Promise<SqliteConnection> | null = null;

async function openSqliteConnection(): Promise<SqliteConnection> {
  if (sharedSqliteConnection) return sharedSqliteConnection;
  if (!sqliteConnectionOpenPromise) {
    sqliteConnectionOpenPromise = openSqliteConnectionOnce()
      .then((conn) => {
        sharedSqliteConnection = conn;
        return conn;
      })
      .catch((err) => {
        sqliteConnectionOpenPromise = null;
        throw err;
      });
  }
  return sqliteConnectionOpenPromise;
}

async function openSqliteConnectionOnce(): Promise<SqliteConnection> {
  const mod = await import("@capacitor-community/sqlite") as SqliteModule;
  if (!mod.CapacitorSQLite || !mod.SQLiteConnection) {
    throw new Error("@capacitor-community/sqlite plugin not available");
  }

  const sqlite = new mod.SQLiteConnection(mod.CapacitorSQLite);
  // SQLiteConnection keeps a connection pool keyed by (dbName, readonly).
  // Re-using an existing entry across HMR / view re-mounts is mandatory —
  // calling createConnection twice for the same name throws "already exists".
  const probe = await sqlite
    .isConnection(DB_NAME, false)
    .catch(() => ({ result: false }));
  const conn = probe.result
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await createOrRetrieveSqliteConnection(sqlite);

  const open = await conn.isDBOpen?.().catch(() => ({ result: false }));
  if (open?.result !== true) {
    await conn.open();
  }

  await conn.execute(`
    CREATE TABLE IF NOT EXISTS ambient_outbox (
      id TEXT PRIMARY KEY,
      item TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_retry_at INTEGER,
      inserted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER,
      synced_owner_user_id TEXT,
      synced_backend_url TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_ambient_outbox_pending
      ON ambient_outbox (status, next_retry_at);
  `);
  await ensureSqliteColumn(conn, "ambient_outbox", "synced_owner_user_id", "TEXT");
  await ensureSqliteColumn(conn, "ambient_outbox", "synced_backend_url", "TEXT");
  await ensureSqliteColumn(conn, "ambient_outbox", "updated_at", "INTEGER NOT NULL DEFAULT 0");
  await runSqliteMigrations(conn);
  return conn;
}

async function ensureSqliteColumn(
  conn: SqliteConnection,
  tableName: string,
  columnName: string,
  columnType: string,
): Promise<void> {
  const res = await conn.query(`PRAGMA table_info(${tableName})`);
  const columns = res.values ?? [];
  if (columns.some((row) => row.name === columnName)) return;
  await conn.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
}

async function runSqliteMigrations(conn: SqliteConnection): Promise<void> {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS ambient_outbox_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await runHealthObservationResyncMigration(conn);
  await runTranscriptCandidateWindowCleanupMigration(conn);
  await runTranscriptCandidateSummaryCleanupMigration(conn);
}

async function runHealthObservationResyncMigration(conn: SqliteConnection): Promise<void> {
  const healthResync = await conn.query(
    "SELECT value FROM ambient_outbox_meta WHERE key = ? LIMIT 1",
    ["health_observation_resync_v1"],
  );
  if (healthResync.values?.[0]?.value === "done") return;

  await conn.run(
    `UPDATE ambient_outbox
     SET status = 'pending',
         synced_at = NULL,
         synced_owner_user_id = NULL,
         last_error = NULL,
         next_retry_at = NULL,
         updated_at = CASE WHEN updated_at > 0 THEN updated_at ELSE inserted_at END
     WHERE status = 'synced'
       AND json_extract(item, '$.kind') = 'health.observation'`,
  );
  await conn.run(
    `INSERT OR REPLACE INTO ambient_outbox_meta (key, value)
     VALUES (?, ?)`,
    ["health_observation_resync_v1", "done"],
  );
}

async function runTranscriptCandidateWindowCleanupMigration(
  conn: SqliteConnection,
): Promise<void> {
  const migration = await conn.query(
    "SELECT value FROM ambient_outbox_meta WHERE key = ? LIMIT 1",
    ["transcript_candidate_outbox_cleanup_v1"],
  );
  if (migration.values?.[0]?.value === "done") return;

  const now = Date.now();
  await conn.execute("DROP TABLE IF EXISTS temp.transcript_candidate_outbox_cleanup_ranked");
  await conn.execute(`
    CREATE TEMP TABLE transcript_candidate_outbox_cleanup_ranked AS
    WITH candidates AS (
      SELECT
        id,
        dedupe_key,
        json_extract(item, '$.payload.local_date') AS local_date,
        json_extract(item, '$.payload.local_window_id') AS local_window_id,
        CASE
          WHEN CAST(json_extract(item, '$.payload.raw_ref_count') AS TEXT) <> ''
           AND CAST(json_extract(item, '$.payload.raw_ref_count') AS TEXT) NOT GLOB '*[^0-9]*'
            THEN CAST(json_extract(item, '$.payload.raw_ref_count') AS INTEGER)
          ELSE 0
        END AS raw_ref_count,
        COALESCE(updated_at, 0) AS updated_at,
        inserted_at
      FROM ambient_outbox
      WHERE json_extract(item, '$.kind') = 'ambient.candidate_window'
        AND json_extract(item, '$.payload.window_type') = 'transcript_session'
        AND NULLIF(json_extract(item, '$.payload.local_date'), '') IS NOT NULL
        AND NULLIF(json_extract(item, '$.payload.local_window_id'), '') IS NOT NULL
    ),
    ranked AS (
      SELECT
        *,
        'ambient:candidate_window:' || local_date
          || ':transcript_session:' || local_window_id AS canonical_key,
        ROW_NUMBER() OVER (
          PARTITION BY local_date, local_window_id
          ORDER BY raw_ref_count DESC, updated_at DESC, inserted_at DESC, id DESC
        ) AS rn,
        COUNT(*) OVER (
          PARTITION BY local_date, local_window_id
        ) AS group_count
      FROM candidates
    )
    SELECT * FROM ranked
    WHERE group_count > 1 OR dedupe_key <> canonical_key
  `);
  await conn.run(`
    DELETE FROM ambient_outbox
    WHERE id IN (
      SELECT id
      FROM transcript_candidate_outbox_cleanup_ranked
      WHERE rn > 1
    )
  `);
  await conn.run(
    `UPDATE ambient_outbox
     SET
       dedupe_key = (
         SELECT canonical_key
         FROM transcript_candidate_outbox_cleanup_ranked r
         WHERE r.id = ambient_outbox.id
       ),
       item = json_set(
         item,
         '$.dedupe_key',
         (
           SELECT canonical_key
           FROM transcript_candidate_outbox_cleanup_ranked r
           WHERE r.id = ambient_outbox.id
         )
       ),
       status = 'pending',
       attempt_count = 0,
       last_error = NULL,
       next_retry_at = NULL,
       synced_at = NULL,
       synced_owner_user_id = NULL,
       synced_backend_url = NULL,
       updated_at = ?
     WHERE id IN (
       SELECT id
       FROM transcript_candidate_outbox_cleanup_ranked
       WHERE rn = 1
     )`,
    [now],
  );
  await conn.execute("DROP TABLE IF EXISTS temp.transcript_candidate_outbox_cleanup_ranked");
  await conn.run(
    `INSERT OR REPLACE INTO ambient_outbox_meta (key, value)
     VALUES (?, ?)`,
    ["transcript_candidate_outbox_cleanup_v1", "done"],
  );
}

async function runTranscriptCandidateSummaryCleanupMigration(
  conn: SqliteConnection,
): Promise<void> {
  const migration = await conn.query(
    "SELECT value FROM ambient_outbox_meta WHERE key = ? LIMIT 1",
    ["transcript_candidate_summary_cleanup_v1"],
  );
  if (migration.values?.[0]?.value === "done") return;

  const res = await conn.query(
    `SELECT id, item
     FROM ambient_outbox
     WHERE json_extract(item, '$.kind') = 'ambient.candidate_window'
       AND json_extract(item, '$.payload.window_type') = 'transcript_session'
       AND item LIKE '%Transcript segment:%'`,
  );
  const now = Date.now();
  for (const row of res.values ?? []) {
    if (typeof row.id !== "string" || typeof row.item !== "string") continue;
    let item: PersonalSignalInput;
    try {
      item = JSON.parse(row.item) as PersonalSignalInput;
    } catch {
      continue;
    }
    const normalized = normalizeTranscriptCandidateSignal(item);
    if (JSON.stringify(normalized) === row.item) continue;
    await conn.run(
      `UPDATE ambient_outbox
       SET item = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(normalized), now, row.id],
    );
  }
  await conn.run(
    `INSERT OR REPLACE INTO ambient_outbox_meta (key, value)
     VALUES (?, ?)`,
    ["transcript_candidate_summary_cleanup_v1", "done"],
  );
}

async function createOrRetrieveSqliteConnection(
  sqlite: SqliteConnectionFactory,
): Promise<SqliteConnection> {
  try {
    return await sqlite.createConnection(DB_NAME, false, "no-encryption", 1, false);
  } catch (err) {
    if (!isConnectionAlreadyExistsError(err)) throw err;
    return sqlite.retrieveConnection(DB_NAME, false);
  }
}

function isConnectionAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("already exists");
}

/**
 * SQLite-backed outbox for native (iOS / Android) — survives app kill
 * and OS suspend. Web builds fall back to ``MemoryOutboxStore`` because
 * the SQLite plugin's web implementation needs IndexedDB setup that we
 * don't want to inflict on the SPA path.
 */
export class SqliteOutboxStore implements OutboxStore {
  readonly kind = "sqlite" as const;
  private conn: SqliteConnection | null = null;

  private async db(): Promise<SqliteConnection> {
    if (!this.conn) this.conn = await openSqliteConnection();
    return this.conn;
  }

  async enqueue(items: PersonalSignalInput[]): Promise<number> {
    if (items.length === 0) return 0;
    const conn = await this.db();
    const now = Date.now();
    let inserted = 0;
    for (const item of items) {
      const record = makeRecord(item, now);
      const existing = await this.getByDedupeKey(record.dedupeKey);
      if (existing) {
        if (!shouldReplaceExistingOutboxRecord(existing, record)) {
          continue;
        }
        const res = await conn.run(
          `UPDATE ambient_outbox
           SET item = ?, status = 'pending', attempt_count = 0,
               last_error = NULL, next_retry_at = NULL, updated_at = ?,
               synced_at = NULL, synced_owner_user_id = NULL,
               synced_backend_url = NULL
           WHERE dedupe_key = ?`,
          [JSON.stringify(record.item), now, record.dedupeKey],
        );
        if ((res.changes?.changes ?? 0) > 0) inserted += 1;
        continue;
      }
      const res = await conn.run(
        `INSERT INTO ambient_outbox
           (id, item, dedupe_key, status, attempt_count, last_error,
            next_retry_at, inserted_at, updated_at, synced_at,
            synced_owner_user_id, synced_backend_url)
         VALUES (?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
        [record.id, JSON.stringify(record.item), record.dedupeKey, now, now],
      );
      if ((res.changes?.changes ?? 0) > 0) inserted += 1;
    }
    return inserted;
  }

  private async getByDedupeKey(dedupeKey: string): Promise<OutboxRecord | null> {
    const conn = await this.db();
    const res = await conn.query(
      "SELECT * FROM ambient_outbox WHERE dedupe_key = ? LIMIT 1",
      [dedupeKey],
    );
    const row = res.values?.[0];
    return row ? rowToRecord(row) : null;
  }

  async pending(
    limit: number,
    now = Date.now(),
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<OutboxRecord[]> {
    const conn = await this.db();
    const statusClause = ownerUserId || backendUrl
      ? `((status = 'pending' OR status = 'failed')
          OR (status = 'synced'
              AND (
                (? IS NOT NULL AND (synced_owner_user_id IS NULL OR synced_owner_user_id <> ?))
                OR (? IS NOT NULL AND (synced_backend_url IS NULL OR synced_backend_url <> ?))
              )))`
      : `(status = 'pending' OR status = 'failed')`;
    const values: unknown[] = ownerUserId || backendUrl
      ? [ownerUserId, ownerUserId, backendUrl, backendUrl, now, limit]
      : [now, limit];
    const res = await conn.query(
      `SELECT * FROM ambient_outbox
       WHERE ${statusClause}
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY inserted_at ASC
       LIMIT ?`,
      values,
    );
    const rows = res.values ?? [];
    return rows.map(rowToRecord);
  }

  async markSynced(
    ids: string[],
    at = Date.now(),
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<void> {
    if (ids.length === 0) return;
    const conn = await this.db();
    const placeholders = ids.map(() => "?").join(",");
    await conn.run(
      `UPDATE ambient_outbox
       SET status = 'synced', synced_at = ?, last_error = NULL,
           next_retry_at = NULL, synced_owner_user_id = ?,
           synced_backend_url = ?, updated_at = ?
       WHERE id IN (${placeholders})`,
      [at, ownerUserId, backendUrl, at, ...ids],
    );
  }

  async markFailed(ids: string[], error: string, nextRetryAt: number): Promise<void> {
    if (ids.length === 0) return;
    const conn = await this.db();
    const now = Date.now();
    const placeholders = ids.map(() => "?").join(",");
    await conn.run(
      `UPDATE ambient_outbox
       SET status = 'failed', attempt_count = attempt_count + 1,
           last_error = ?, next_retry_at = ?, updated_at = ?
       WHERE id IN (${placeholders})`,
      [error.slice(0, 500), nextRetryAt, now, ...ids],
    );
  }

  async prune(now = Date.now()): Promise<number> {
    const conn = await this.db();
    const res = await conn.run(
      `DELETE FROM ambient_outbox
       WHERE (status = 'synced' AND synced_at IS NOT NULL AND synced_at < ?)
          OR (inserted_at < ?)`,
      [now - SYNCED_RETENTION_MS, now - DEFAULT_TTL_MS],
    );
    return res.changes?.changes ?? 0;
  }

  async count(
    ownerUserId: string | null = null,
    backendUrl: string | null = null,
  ): Promise<number> {
    const conn = await this.db();
    const res = ownerUserId || backendUrl
      ? await conn.query(
        `SELECT COUNT(*) AS n FROM ambient_outbox
         WHERE status <> 'synced'
            OR (? IS NOT NULL AND (synced_owner_user_id IS NULL OR synced_owner_user_id <> ?))
            OR (? IS NOT NULL AND (synced_backend_url IS NULL OR synced_backend_url <> ?))`,
        [ownerUserId, ownerUserId, backendUrl, backendUrl],
      )
      : await conn.query(
        `SELECT COUNT(*) AS n FROM ambient_outbox WHERE status <> 'synced'`,
      );
    const n = res.values?.[0]?.n;
    return typeof n === "number" ? n : 0;
  }
}

function rowToRecord(row: Record<string, unknown>): OutboxRecord {
  const itemJson = typeof row.item === "string" ? row.item : "{}";
  let parsedItem: PersonalSignalInput;
  try {
    parsedItem = JSON.parse(itemJson) as PersonalSignalInput;
  } catch {
    parsedItem = { kind: "unknown", title: "", summary: "" };
  }
  return {
    id: String(row.id),
    item: parsedItem,
    dedupeKey: String(row.dedupe_key ?? ""),
    status: (row.status as OutboxStatus) ?? "pending",
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: row.last_error === null || row.last_error === undefined
      ? null : String(row.last_error),
    nextRetryAt: row.next_retry_at === null || row.next_retry_at === undefined
      ? null : Number(row.next_retry_at),
    insertedAt: Number(row.inserted_at ?? Date.now()),
    updatedAt: Number(row.updated_at ?? row.inserted_at ?? Date.now()),
    syncedAt: row.synced_at === null || row.synced_at === undefined
      ? null : Number(row.synced_at),
    syncedOwnerUserId: row.synced_owner_user_id === null || row.synced_owner_user_id === undefined
      ? null : String(row.synced_owner_user_id),
    syncedBackendUrl: row.synced_backend_url === null || row.synced_backend_url === undefined
      ? null : String(row.synced_backend_url),
  };
}
