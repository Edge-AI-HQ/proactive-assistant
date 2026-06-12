/**
 * 同步引擎回放测试 —— better-sqlite3 真库实现 DatabasePort（顺手验证
 * 「薄 port 可被任何 SQLite 实现满足」），delta 响应经 transport 的
 * fetchImpl 注入回放。锁的契约：bootstrap 分页、增量不丢不重、断点续传、
 * 幂等 upsert、行+游标原子提交、页数保险丝。
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureTransport } from "../transport/config";
import { ensureSyncSchema, SYNC_SCHEMA_VERSION } from "./schema";
import { SyncEngine } from "./engine";
import { betterSqliteDriver, jsonResponse } from "./test-driver";

const fetchMock = vi.fn();

function configure() {
  configureTransport({
    baseUrl: "",
    getAuthHeaders: async () => ({}),
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
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

describe("messages FTS (Sync-C)", () => {
  it("indexes text/reasoning parts in the same transaction and stays duplicate-free on replay", async () => {
    configure();
    const raw = new Database(":memory:");
    const engine = new SyncEngine({ db: betterSqliteDriver(raw) });
    const page = {
      ok: true,
      rows: [
        {
          id: "1",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "thinking about flights" },
            { type: "text", text: "Booked the Tokyo flight" },
            { type: "toolCall", toolName: "browser", state: "done" },
          ],
        },
      ],
      cursor: 1,
      hasMore: false,
    };
    fetchMock.mockResolvedValue(jsonResponse(page));
    await engine.syncMessages("main-1");
    // 重放同一页（游标丢失场景）——FTS 行不得翻倍。
    raw.prepare("DELETE FROM sync_state").run();
    await engine.syncMessages("main-1");

    const hits = raw
      .prepare("SELECT message_id, thread_id FROM messages_fts WHERE messages_fts MATCH 'tokyo'")
      .all() as Array<{ message_id: string; thread_id: string }>;
    expect(hits).toEqual([{ message_id: "1", thread_id: "main-1" }]);
    // reasoning part 同样可检索；toolCall 不入索引（无 text 可索）。
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'thinking'").get(),
    ).toEqual({ n: 1 });
  });
});

describe("syncCards", () => {
  function cardEntry(id: string, title: string, summary: string) {
    return {
      card: {
        id,
        goalBasket: "personal",
        title,
        whyNow: "deadline approaching",
        summary,
        primaryAction: { label: "Go", type: "confirm" },
        secondaryActions: [],
        confidence: 0.9,
        urgency: 0.5,
        importance: 0.5,
        sources: [],
        agentChain: [],
        createdAt: "2026-06-11T00:00:00+00:00",
      },
      runId: `run-${id}`,
      runCompletedAt: "2026-06-11T00:00:00+00:00",
      score: { overall: 0.8, pass: true },
      latestOutcome: null,
      outcomeAt: null,
    };
  }

  it("full-upserts the bounded projection and rebuilds the FTS index", async () => {
    configure();
    const raw = new Database(":memory:");
    const engine = new SyncEngine({ db: betterSqliteDriver(raw) });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        cards: [cardEntry("c1", "Renew passport", "expires soon"), cardEntry("c2", "Book hotel", "trip to Osaka")],
      }),
    );
    // 首轮（空镜像）：全部入库但不算「新」——桌面通知不被 bootstrap 轰炸。
    const first = await engine.syncCards();
    expect(first.pulled).toBe(2);
    expect(first.newCardIds).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toContain("/cards?limit=200");

    // 第二轮：c2 掉出投影（outcome 隐藏）、c1 标题变、c3 新出现 —— 全量
    // 替换语义：本地表精确镜像最新响应；增量判定只认 c3。
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        cards: [
          cardEntry("c1", "Renew passport NOW", "expires soon"),
          cardEntry("c3", "Pay rent", "due friday"),
        ],
      }),
    );
    const second = await engine.syncCards();
    expect(second.pulled).toBe(2);
    expect(second.newCardIds).toEqual(["c3"]);

    const rows = raw.prepare("SELECT card_id, payload_json FROM cards ORDER BY card_id").all() as Array<{
      card_id: string;
      payload_json: string;
    }>;
    expect(rows.map((r) => r.card_id)).toEqual(["c1", "c3"]);
    expect(JSON.parse(rows[0].payload_json).title).toBe("Renew passport NOW");
    const hits = raw
      .prepare("SELECT card_id FROM cards_fts WHERE cards_fts MATCH 'passport'")
      .all() as Array<{ card_id: string }>;
    expect(hits).toEqual([{ card_id: "c1" }]);
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM cards_fts WHERE cards_fts MATCH 'osaka'").get(),
    ).toEqual({ n: 0 });
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
