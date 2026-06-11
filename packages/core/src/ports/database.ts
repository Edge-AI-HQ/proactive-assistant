/**
 * Database port —— 本地 SQLite 的最小注入面（分层方案 §4.5 的 ports 表
 * 第一个真实落地；同步引擎是它的主要消费者）。
 *
 * 三端 driver 各自实现并在入口注入：
 *   - Capacitor iOS: @capacitor-community/sqlite（app lib/sync/capacitor-database.ts）
 *   - Expo RN: expo-sqlite（届时）
 *   - Electron: better-sqlite3 经 IPC（届时）
 *   - web 浏览器: 暂无 driver → 引擎不激活（sqlite-wasm 留 Sync-D）
 *
 * 接口刻意薄（run/query/transaction）：与 PowerSync/Evolu/Zero 的内部
 * port 同形态——sync engine 不需要 ORM，手写 SQL + 薄 driver 即可三端跑
 * 同一套（同步引擎文档 §2.4 的调研结论）。
 */

export type SqlParam = string | number | null;

export interface DatabaseTx {
  /** 写语句（INSERT/UPDATE/DELETE/DDL）。 */
  run(sql: string, params?: SqlParam[]): Promise<void>;
  /** 读语句，返回行对象数组。 */
  query(sql: string, params?: SqlParam[]): Promise<Record<string, unknown>[]>;
}

export interface DatabasePort extends DatabaseTx {
  /** 事务中执行 fn；fn 抛错则整体回滚。同步引擎用它保证
   *  「批量行写入 + 游标推进」的原子性（断电不半套）。 */
  transaction<T>(fn: (tx: DatabaseTx) => Promise<T>): Promise<T>;
}
