/**
 * @pin-ai/core Database port 的 Electron 实现——薄 IPC 包装：main process
 * 持 node:sqlite（per-user 库于 userData/sync/），renderer 经 preload 的
 * dbRun/dbQuery 白名单执行 SQL。
 *
 * 事务与 Capacitor driver 同构：显式 BEGIN/COMMIT/ROLLBACK 语句 + 单连接
 * + 调用方（sync-bootstrap 的 serialize 队列）保证无并发写者。调用方负责
 * isElectron gate——web/Capacitor 下 window.pinaiDesktop 不存在，本模块
 * 永不被调用。
 */
import type { DatabasePort, DatabaseTx, SqlParam } from "@pin-ai/core";

export function createElectronDatabase(dbName: string): DatabasePort {
  const run = async (sql: string, params: SqlParam[] = []): Promise<void> => {
    await window.pinaiDesktop!.dbRun(dbName, sql, params);
  };
  const query = (
    sql: string,
    params: SqlParam[] = [],
  ): Promise<Record<string, unknown>[]> =>
    window.pinaiDesktop!.dbQuery(dbName, sql, params);
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
