/**
 * @pin-ai/core Database port 的 Expo 实现：expo-sqlite（SDK 内置，FTS5
 * 可用）。事务与 Capacitor/Electron driver 同构：显式 BEGIN/COMMIT +
 * 单连接 + 调用方（core SyncScheduler 的串行队列）保证无并发写者。
 */
import * as SQLite from "expo-sqlite";
import type { DatabasePort, DatabaseTx, SqlParam } from "@pin-ai/core";

export function createExpoDatabase(dbName: string): DatabasePort {
  let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
  const db = (): Promise<SQLite.SQLiteDatabase> => {
    if (!dbPromise) {
      dbPromise = SQLite.openDatabaseAsync(`${dbName}.db`).catch((err) => {
        dbPromise = null; // 失败可重试
        throw err;
      });
    }
    return dbPromise;
  };
  const run = async (sql: string, params: SqlParam[] = []): Promise<void> => {
    await (await db()).runAsync(sql, params as SQLite.SQLiteBindParams);
  };
  const query = async (
    sql: string,
    params: SqlParam[] = [],
  ): Promise<Record<string, unknown>[]> =>
    (await db()).getAllAsync<Record<string, unknown>>(
      sql,
      params as SQLite.SQLiteBindParams,
    );
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
