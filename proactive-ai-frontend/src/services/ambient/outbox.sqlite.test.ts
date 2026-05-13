// Round-trip test for SqliteOutboxStore. Backs the
// `@capacitor-community/sqlite` plugin with sql.js (in-memory SQLite
// WASM) wrapped in a SQLiteConnection-shaped mock. The mock enforces
// the wrapper API surface (positional args on createConnection /
// retrieveConnection / isConnection / open / execute / run / query) so
// reverting to the raw-plugin-with-positional-args bug would fail here
// instead of silently breaking on device.

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import initSqlJs, { type Database } from "sql.js";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const pool = new Map<string, Database>();

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
    return { result: pool.has(poolKey(database, readonly)) };
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
    return new FakeDBConnection(database, readonly);
  }
  async retrieveConnection(database: string, readonly: boolean) {
    if (!pool.has(poolKey(database, readonly))) {
      throw new Error(`retrieveConnection: ${database} not open`);
    }
    return new FakeDBConnection(database, readonly);
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
});

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
});
