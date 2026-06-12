/**
 * 测试共用：better-sqlite3 实现 DatabasePort（顺手验证「薄 port 可被任何
 * SQLite 实现满足」）+ transport fetch mock。只被 *.test.ts import，
 * 不从 index.ts 导出（better-sqlite3 是 devDependency，不进应用 bundle）。
 */
import type Database from "better-sqlite3";

import type { DatabasePort, DatabaseTx, SqlParam } from "../ports/database";

export function betterSqliteDriver(db: Database.Database): DatabasePort {
  const tx: DatabaseTx = {
    run: async (sql: string, params: SqlParam[] = []) => {
      db.prepare(sql).run(...params);
    },
    query: async (sql: string, params: SqlParam[] = []) =>
      db.prepare(sql).all(...params) as Record<string, unknown>[],
  };
  return {
    ...tx,
    transaction: async (fn) => {
      // better-sqlite3 的内置 transaction 不支持 async fn；引擎事务体内
      // 只有顺序 await 的本地语句，手动 BEGIN/COMMIT 等价且足够。
      db.prepare("BEGIN").run();
      try {
        const out = await fn(tx);
        db.prepare("COMMIT").run();
        return out;
      } catch (err) {
        db.prepare("ROLLBACK").run();
        throw err;
      }
    },
  };
}

export function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
