/**
 * @pin-ai/core Database port 的 Capacitor 实现（Sync-B2 第一个 driver）。
 *
 * 连接管理照 ambient timeline store 的既有惯例（动态 import + isConnection
 * 探测 + retrieve/create + open 检查）；独立 DB 文件 `pinai_sync`，与
 * ambient 的库隔离生命周期。调用方（sync-bootstrap）负责 isNative gate——
 * web build 里本模块经 vite alias 指向 native-plugin-stub，永不真调。
 *
 * 事务：显式 BEGIN/COMMIT/ROLLBACK 语句，每句 run 的 transaction 参数传
 * false（关掉 plugin 的逐句自动事务，避免与显式事务嵌套冲突）。引擎是
 * 单实例顺序跑（sync-bootstrap 串行调度），连接无并发写者。
 */
import type { DatabasePort, DatabaseTx, SqlParam } from "@pin-ai/core";

const DB_NAME = "pinai_sync";

interface SqliteConnection {
  open(): Promise<void>;
  isDBOpen?(): Promise<{ result?: boolean }>;
  run(
    sql: string,
    values?: unknown[],
    transaction?: boolean,
  ): Promise<{ changes?: { changes?: number } }>;
  query(sql: string, values?: unknown[]): Promise<{ values?: Record<string, unknown>[] }>;
}

interface SqliteConnectionFactory {
  createConnection(
    dbName: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<SqliteConnection>;
  retrieveConnection(dbName: string, readonly: boolean): Promise<SqliteConnection>;
  isConnection(dbName: string, readonly: boolean): Promise<{ result?: boolean }>;
}

interface SqliteModule {
  CapacitorSQLite?: unknown;
  SQLiteConnection?: new (sqlite: unknown) => SqliteConnectionFactory;
}

let connPromise: Promise<SqliteConnection> | null = null;

async function openConnection(): Promise<SqliteConnection> {
  const mod = (await import("@capacitor-community/sqlite")) as SqliteModule;
  if (!mod.CapacitorSQLite || !mod.SQLiteConnection) {
    throw new Error("@capacitor-community/sqlite plugin not available");
  }
  const sqlite = new mod.SQLiteConnection(mod.CapacitorSQLite);
  const probe = await sqlite.isConnection(DB_NAME, false).catch(() => ({ result: false }));
  const conn = probe.result
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, "no-encryption", 1, false);
  const open = await conn.isDBOpen?.().catch(() => ({ result: false }));
  if (open?.result !== true) await conn.open();
  return conn;
}

function db(): Promise<SqliteConnection> {
  if (!connPromise) {
    connPromise = openConnection().catch((err) => {
      connPromise = null; // 失败可重试（下次调用重新建连）
      throw err;
    });
  }
  return connPromise;
}

async function run(sql: string, params: SqlParam[] = []): Promise<void> {
  const conn = await db();
  await conn.run(sql, params, false);
}

async function query(
  sql: string,
  params: SqlParam[] = [],
): Promise<Record<string, unknown>[]> {
  const conn = await db();
  const out = await conn.query(sql, params);
  return out.values ?? [];
}

export function createCapacitorDatabase(): DatabasePort {
  const tx: DatabaseTx = { run, query };
  return {
    ...tx,
    transaction: async <T>(fn: (t: DatabaseTx) => Promise<T>): Promise<T> => {
      await run("BEGIN");
      try {
        const out = await fn(tx);
        await run("COMMIT");
        return out;
      } catch (err) {
        await run("ROLLBACK").catch(() => {});
        throw err;
      }
    },
  };
}
