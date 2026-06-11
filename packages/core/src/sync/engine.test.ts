/**
 * 同步引擎回放测试 —— better-sqlite3 真库实现 DatabasePort（顺手验证
 * 「薄 port 可被任何 SQLite 实现满足」），delta 响应经 transport 的
 * fetchImpl 注入回放。锁的契约：bootstrap 分页、增量不丢不重、断点续传、
 * 幂等 upsert、行+游标原子提交、页数保险丝。
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureTransport } from "../transport/config";
import type { DatabasePort, DatabaseTx, SqlParam } from "../ports/database";
import { ensureSyncSchema, SYNC_SCHEMA_VERSION } from "./schema";
import { SyncEngine } from "./engine";

function betterSqliteDriver(db: Database.Database): DatabasePort {
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

const fetchMock = vi.fn();

function configure() {
  configureTransport({
    baseUrl: "",
    getAuthHeaders: async () => ({}),
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function msg(id: number, text: string) {
  return { id: String(id), role: "user", parts: [{ type: "text", text }], createdAt: id * 1000 };
}

afterEach(() => fetchMock.mockReset());

describe("ensureSyncSchema", () => {
  it("applies migrations once and is idempotent", async () => {
    const db = betterSqliteDriver(new Database(":memory:"));
    await ensureSyncSchema(db);
    await ensureSyncSchema(db);
    const v = await db.query("PRAGMA user_version");
    expect(Number(v[0].user_version)).toBe(SYNC_SCHEMA_VERSION);
    await db.run("INSERT INTO threads (thread_id, kind, updated_at) VALUES ('t', 'main', 'x')");
  });
});

describe("syncMessages", () => {
  it("bootstraps across pages, then resumes from the stored cursor without re-pulling", async () => {
    configure();
    const raw = new Database(":memory:");
    const engine = new SyncEngine({ db: betterSqliteDriver(raw) });

    // Bootstrap：两页（hasMore 翻页）。
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, rows: [msg(1, "m1"), msg(2, "m2")], cursor: 2, hasMore: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, rows: [msg(3, "m3")], cursor: 3, hasMore: false }),
      );
    expect((await engine.syncMessages("main-1")).pulled).toBe(3);
    expect(fetchMock.mock.calls[0][0]).toContain("since=0");
    expect(fetchMock.mock.calls[1][0]).toContain("since=2");

    // 增量：从游标 3 续拉，只来新行。
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, rows: [msg(4, "m4")], cursor: 4, hasMore: false }),
    );
    expect((await engine.syncMessages("main-1")).pulled).toBe(1);
    expect(fetchMock.mock.calls[2][0]).toContain("since=3");

    const rows = raw.prepare("SELECT id, parts_json FROM messages ORDER BY id").all() as Array<{
      id: number;
      parts_json: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(rows[0].parts_json)[0].text).toBe("m1");
  });

  it("re-applying the same page is idempotent (INSERT OR REPLACE on server id)", async () => {
    configure();
    const raw = new Database(":memory:");
    const engine = new SyncEngine({ db: betterSqliteDriver(raw) });
    const page = { ok: true, rows: [msg(1, "m1")], cursor: 1, hasMore: false };
    fetchMock.mockResolvedValue(jsonResponse(page));
    await engine.syncMessages("main-1");
    // 模拟游标丢失后重放同一页（全删重建语义的最小版）。
    raw.prepare("DELETE FROM sync_state").run();
    await engine.syncMessages("main-1");
    const n = raw.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("commits rows and cursor atomically — a failing batch leaves neither", async () => {
    configure();
    const raw = new Database(":memory:");
    const driver = betterSqliteDriver(raw);
    // 第二条 messages INSERT 注入写失败（磁盘满/约束违反的等价物）→
    // 引擎事务必须整体回滚：第一行与游标都不落库。
    let inserts = 0;
    const flaky: typeof driver = {
      ...driver,
      transaction: (fn) =>
        driver.transaction((tx) =>
          fn({
            query: tx.query,
            run: async (sql, params) => {
              if (sql.includes("INSERT OR REPLACE INTO messages") && ++inserts === 2) {
                throw new Error("disk full");
              }
              return tx.run(sql, params);
            },
          }),
        ),
    };
    const engine = new SyncEngine({ db: flaky });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, rows: [msg(1, "ok"), msg(2, "bad")], cursor: 2, hasMore: false }),
    );
    await expect(engine.syncMessages("main-1")).rejects.toThrow("disk full");
    const n = raw.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    expect(n.n).toBe(0);
    const cursors = raw.prepare("SELECT * FROM sync_state").all();
    expect(cursors).toEqual([]);
  });

  it("page fuse stops a non-advancing hasMore loop", async () => {
    configure();
    const engine = new SyncEngine({ db: betterSqliteDriver(new Database(":memory:")) });
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, rows: [], cursor: 0, hasMore: true }),
    );
    await engine.syncMessages("main-1");
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(50);
  });
});

describe("syncThreads", () => {
  it("upserts thread rows and advances the composite cursor; soft state overwrites in place", async () => {
    configure();
    const raw = new Database(":memory:");
    const engine = new SyncEngine({ db: betterSqliteDriver(raw) });
    const t = {
      threadId: "main-1-x",
      kind: "main",
      cardId: null,
      archived: false,
      messageCount: 1,
      lastMessageAt: null,
      updatedAt: "2026-06-11T00:00:00+00:00",
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, rows: [t], cursor: "c1", hasMore: false }),
    );
    await engine.syncThreads();

    // 同一行 archived 翻转随增量 upsert 覆盖（无 tombstone 的软删语义）。
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        rows: [{ ...t, archived: true, updatedAt: "2026-06-11T01:00:00+00:00" }],
        cursor: "c2",
        hasMore: false,
      }),
    );
    expect(fetchMock.mock.calls.length).toBe(1);
    await engine.syncThreads();
    expect(fetchMock.mock.calls[1][0]).toContain("cursor=c1");

    const rows = raw.prepare("SELECT archived FROM threads").all() as Array<{ archived: number }>;
    expect(rows).toEqual([{ archived: 1 }]);
    const stats = await engine.stats();
    expect(stats.threads).toBe(1);
  });
});
