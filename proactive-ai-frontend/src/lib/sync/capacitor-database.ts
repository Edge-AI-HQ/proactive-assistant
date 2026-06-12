/**
 * @pin-ai/core Database port 的 Capacitor 实现（Sync-B2 第一个 driver）。
 *
 * 连接管理照 ambient timeline store 的既有惯例（动态 import + isConnection
 * 探测 + retrieve/create + open 检查）；**per-user DB 文件**
 * `pinai_sync_<supabase_user_id>`（业界 per-account database 惯例：换账号
 * 登录数据/游标/outbox 天然隔离，不依赖登出清理；同账号重登录秒恢复），
 * 与 ambient 的库隔离生命周期。调用方（sync-bootstrap）负责 isNative
 * gate——web build 里 `@capacitor-community/sqlite` 经 vite alias 指向
 * native-plugin-stub（调用即 throw），但 gate 保证永不触发。
 *
 * 事务：显式 BEGIN/COMMIT/ROLLBACK 语句，每句 run 的 transaction 参数传
 * false（关掉 plugin 的逐句自动事务，避免与显式事务嵌套冲突）。引擎是
 * 单实例顺序跑（sync-bootstrap 串行调度），连接无并发写者。
 */
import type { DatabasePort, DatabaseTx, SqlParam } from "@pin-ai/core";

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

const connPromises = new Map<string, Promise<SqliteConnection>>();

async function openConnection(dbName: string): Promise<SqliteConnection> {
  const mod = (await import("@capacitor-community/sqlite")) as SqliteModule;
  if (!mod.CapacitorSQLite || !mod.SQLiteConnection) {
    throw new Error("@capacitor-community/sqlite plugin not available");
  }
  const sqlite = new mod.SQLiteConnection(mod.CapacitorSQLite);
  const probe = await sqlite.isConnection(dbName, false).catch(() => ({ result: false }));
  const conn = probe.result
    ? await sqlite.retrieveConnection(dbName, false)
    : await sqlite.createConnection(dbName, false, "no-encryption", 1, false);
  const open = await conn.isDBOpen?.().catch(() => ({ result: false }));
  if (open?.result !== true) await conn.open();
  return conn;
}

function db(dbName: string): Promise<SqliteConnection> {
  let p = connPromises.get(dbName);
  if (!p) {
    p = openConnection(dbName).catch((err) => {
      connPromises.delete(dbName); // 失败可重试（下次调用重新建连）
      throw err;
    });
    connPromises.set(dbName, p);
  }
  return p;
}

export function createCapacitorDatabase(dbName: string): DatabasePort {
  const run = async (sql: string, params: SqlParam[] = []): Promise<void> => {
    const conn = await db(dbName);
    await conn.run(sql, params, false);
  };
  const query = async (
    sql: string,
    params: SqlParam[] = [],
  ): Promise<Record<string, unknown>[]> => {
    const conn = await db(dbName);
    const out = await conn.query(sql, params);
    return out.values ?? [];
  };
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
