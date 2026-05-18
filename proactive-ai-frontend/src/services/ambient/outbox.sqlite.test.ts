// Round-trip test for SqliteOutboxStore. Backs the
// `@capacitor-community/sqlite` plugin with sql.js (in-memory SQLite
// WASM) wrapped in a SQLiteConnection-shaped mock. The mock enforces
// the wrapper API surface (positional args on createConnection /
// retrieveConnection / isConnection / open / execute / run / query) so
// reverting to the raw-plugin-with-positional-args bug would fail here
// instead of silently breaking on device.

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import initSqlJs, { type Database } from "sql.js";

import type { PersonalSignalInput } from "@/lib/devices";
import { stableHash } from "./timeline/utils";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const pool = new Map<string, Database>();
const connections = new Map<string, FakeDBConnection>();
let createConnectionCount = 0;

function poolKey(database: string, readonly: boolean) {
  return `${readonly ? "RO" : "RW"}_${database}`;
}

class FakeDBConnection {
  constructor(private database: string, private readonly: boolean) {}
  async open(): Promise<void> {
    if (!pool.has(poolKey(this.database, this.readonly))) {
      pool.set(poolKey(this.database, this.readonly), new SQL.Database());
    }
  }
  private get db(): Database {
    const db = pool.get(poolKey(this.database, this.readonly));
    if (!db) throw new Error(`connection ${this.database} not opened`);
    return db;
  }
  async execute(statements: string) {
    this.db.exec(statements);
    return { changes: { changes: 0, lastId: 0 } };
  }
  async run(statement: string, values: unknown[] = []) {
    const stmt = this.db.prepare(statement);
    stmt.bind(values as never);
    stmt.step();
    stmt.free();
    return { changes: { changes: this.db.getRowsModified(), lastId: 0 } };
  }
  async query(statement: string, values: unknown[] = []) {
    const stmt = this.db.prepare(statement);
    stmt.bind(values as never);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
    stmt.free();
    return { values: rows };
  }
}

class FakeSQLiteConnection {
  constructor(plugin: unknown) {
    if (!plugin) throw new Error("SQLiteConnection: plugin is required");
  }
  async isConnection(database: string, readonly: boolean) {
    return { result: connections.has(poolKey(database, readonly)) };
  }
  async createConnection(
    database: string,
    _encrypted: boolean,
    _mode: string,
    _version: number,
    readonly: boolean,
  ) {
    if (typeof database !== "string" || database.length === 0) {
      throw new Error("CreateConnection: Must provide a database name");
    }
    const key = poolKey(database, readonly);
    if (connections.has(key)) {
      throw new Error(`Connection ${database} already exists`);
    }
    createConnectionCount += 1;
    const conn = new FakeDBConnection(database, readonly);
    connections.set(key, conn);
    return conn;
  }
  async retrieveConnection(database: string, readonly: boolean) {
    const conn = connections.get(poolKey(database, readonly));
    if (!conn) {
      throw new Error(`retrieveConnection: ${database} not open`);
    }
    return conn;
  }
}

vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: { __raw: true },
  SQLiteConnection: FakeSQLiteConnection,
}));

beforeAll(async () => {
  SQL = await initSqlJs();
});

afterEach(() => {
  for (const db of pool.values()) db.close();
  pool.clear();
  connections.clear();
  createConnectionCount = 0;
  vi.resetModules();
});

function transcriptCandidate(
  rawRefCount: number,
  contentHash: string,
  summary: string,
): PersonalSignalInput {
  return {
    id: `candidate-${contentHash}`,
    kind: "ambient.candidate_window",
    title: "Ambient transcript_session window",
    summary,
    dedupe_key: `legacy:${contentHash}`,
    occurred_at: "2026-05-11T11:00:00.000Z",
    payload: {
      window_type: "transcript_session",
      local_date: "2026-05-11",
      local_window_id: "win-transcript",
      raw_ref_count: rawRefCount,
      content_hash: contentHash,
      compact_context: summary,
    },
  };
}

function legacyTranscriptCandidate(
  id: string,
  rawRefCount: number,
  contentHash: string,
  summary: string,
): PersonalSignalInput {
  return {
    ...transcriptCandidate(rawRefCount, contentHash, summary),
    id,
    dedupe_key: `ambient:candidate_window:2026-05-11:win-transcript:${contentHash}`,
  };
}

function seedLegacyOutboxRows(rows: Array<{
  id: string;
  item: PersonalSignalInput;
  status: string;
  attemptCount: number;
  insertedAt: number;
  updatedAt: number;
}>): void {
  const db = new SQL.Database();
  pool.set(poolKey("pin_ambient_outbox", false), db);
  db.exec(`
    CREATE TABLE ambient_outbox (
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
    CREATE INDEX ix_ambient_outbox_pending
      ON ambient_outbox (status, next_retry_at);
  `);
  for (const row of rows) {
    const stmt = db.prepare(`
      INSERT INTO ambient_outbox
        (id, item, dedupe_key, status, attempt_count, last_error,
         next_retry_at, inserted_at, updated_at, synced_at,
         synced_owner_user_id, synced_backend_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.bind([
      row.id,
      JSON.stringify(row.item),
      row.item.dedupe_key,
      row.status,
      row.attemptCount,
      row.status === "failed" ? "retryable_failed or unacknowledged" : null,
      row.status === "failed" ? row.updatedAt - 1 : null,
      row.insertedAt,
      row.updatedAt,
      row.status === "synced" ? row.updatedAt : null,
      row.status === "synced" ? "user-a" : null,
      row.status === "synced" ? "https://dev.example" : null,
    ]);
    stmt.step();
    stmt.free();
  }
}

describe("SqliteOutboxStore (sql.js round-trip)", () => {
  test("enqueue persists rows and dedupes by dedupe_key", async () => {
    const { SqliteOutboxStore } = await import("./outbox");
    const store = new SqliteOutboxStore();

    const insertedFirst = await store.enqueue([
      { kind: "session_summary", title: "a", summary: "first", dedupe_key: "k1" },
      { kind: "session_summary", title: "b", summary: "second", dedupe_key: "k2" },
    ]);
    const insertedSecond = await store.enqueue([
      { kind: "session_summary", title: "a", summary: "dup", dedupe_key: "k1" },
    ]);

    expect(insertedFirst).toBe(2);
    expect(insertedSecond).toBe(0);
    expect(await store.count()).toBe(2);
  });

  test("pending → markSynced → count drops", async () => {
    const { SqliteOutboxStore } = await import("./outbox");
    const store = new SqliteOutboxStore();

    await store.enqueue([
      { kind: "device.location", title: "x", summary: "x", dedupe_key: "loc:1" },
    ]);
    const pending = await store.pending(10);
    expect(pending).toHaveLength(1);

    await store.markSynced([pending[0].id]);
    expect(await store.count()).toBe(0);
  });

  test("markFailed bumps attempt_count and hides until retry time", async () => {
    const { SqliteOutboxStore } = await import("./outbox");
    const store = new SqliteOutboxStore();

    await store.enqueue([
      { kind: "device.activity", title: "y", summary: "y", dedupe_key: "act:1" },
    ]);
    const [row] = await store.pending(1);
    const retryAt = Date.now() + 60_000;

    await store.markFailed([row.id], "offline", retryAt);

    expect(await store.pending(1, retryAt - 1)).toEqual([]);
    const retryable = await store.pending(1, retryAt);
    expect(retryable[0]?.attemptCount).toBe(1);
    expect(retryable[0]?.lastError).toBe("offline");
  });

  test("concurrent stores share the in-flight native connection", async () => {
    const { SqliteOutboxStore } = await import("./outbox");
    const first = new SqliteOutboxStore();
    const second = new SqliteOutboxStore();

    await Promise.all([first.count(), second.count()]);

    expect(createConnectionCount).toBe(1);
  });

  test("upserts transcript candidate windows to one latest SQLite row", async () => {
    const { SqliteOutboxStore } = await import("./outbox");
    const store = new SqliteOutboxStore();

    expect(await store.enqueue([transcriptCandidate(1, "hash-1", "first")])).toBe(1);
    expect(await store.enqueue([transcriptCandidate(5, "hash-5", "latest")])).toBe(1);
    expect(await store.enqueue([transcriptCandidate(3, "hash-3", "stale")])).toBe(0);

    const pending = await store.pending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dedupeKey).toBe(
      "ambient:candidate_window:2026-05-11:transcript_session:win-transcript",
    );
    expect(pending[0]?.item.summary).toBe("latest");
    expect(pending[0]?.item.payload?.raw_ref_count).toBe(5);
    expect(pending[0]?.updatedAt).toBeGreaterThanOrEqual(pending[0]?.insertedAt ?? 0);
  });

  test("fresh transcript candidate content requeues a synced SQLite row", async () => {
    const { SqliteOutboxStore } = await import("./outbox");
    const store = new SqliteOutboxStore();

    await store.enqueue([transcriptCandidate(1, "hash-1", "first")]);
    const [record] = await store.pending(1);
    await store.markSynced([record.id], Date.now(), "user-a", "https://dev.example");

    expect(await store.count("user-a", "https://dev.example")).toBe(0);
    expect(await store.enqueue([transcriptCandidate(2, "hash-2", "fresh")])).toBe(1);

    const pending = await store.pending(1, Date.now() + 1, "user-a", "https://dev.example");
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.syncedAt).toBeNull();
    expect(pending[0]?.attemptCount).toBe(0);
    expect(pending[0]?.item.summary).toBe("fresh");
  });

  test("migration collapses legacy transcript outbox duplicates and requeues winner", async () => {
    seedLegacyOutboxRows([
      {
        id: "legacy-1",
        item: legacyTranscriptCandidate("legacy-1", 1, "hash-1", "Transcript segment: first"),
        status: "failed",
        attemptCount: 3,
        insertedAt: 1_000,
        updatedAt: 1_100,
      },
      {
        id: "legacy-5",
        item: legacyTranscriptCandidate(
          "legacy-5",
          5,
          "hash-5",
          "Transcript segment: latest",
        ),
        status: "failed",
        attemptCount: 4,
        insertedAt: 1_200,
        updatedAt: 1_300,
      },
      {
        id: "other-window",
        item: {
          ...legacyTranscriptCandidate("other-window", 1, "other", "other"),
          payload: {
            ...legacyTranscriptCandidate("other-window", 1, "other", "other").payload,
            local_window_id: "win-other",
          },
          dedupe_key: "ambient:candidate_window:2026-05-11:win-other:other",
        },
        status: "synced",
        attemptCount: 1,
        insertedAt: 1_400,
        updatedAt: 1_500,
      },
    ]);

    const { SqliteOutboxStore } = await import("./outbox");
    const store = new SqliteOutboxStore();
    const pending = await store.pending(10, Date.now() + 1);

    expect(pending).toHaveLength(2);
    const migrated = pending.find((row) => row.id === "legacy-5");
    expect(migrated?.dedupeKey).toBe(
      "ambient:candidate_window:2026-05-11:transcript_session:win-transcript",
    );
    expect(migrated?.item.dedupe_key).toBe(migrated?.dedupeKey);
    expect(migrated?.status).toBe("pending");
    expect(migrated?.attemptCount).toBe(0);
    expect(migrated?.item.summary).toBe("latest");
    expect(migrated?.item.payload?.compact_context).toBe("latest");
    expect(migrated?.item.payload?.content_hash).toBe(stableHash("latest"));
    expect(pending.some((row) => row.id === "legacy-1")).toBe(false);
  });
});
