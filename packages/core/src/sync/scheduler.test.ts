/**
 * 调度器契约（从 web 端 sync-bootstrap 的调度测试迁移并升格为真引擎版）：
 * 全局串行（事务永不嵌套/交错）、push-then-pull pass 顺序、门铃风暴
 * trailing 合并、新卡通知钩子、失败不上抛。真 better-sqlite3 + 慢速
 * fetchMock——比 mock 引擎更接近三端真实执行。
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureTransport } from "../transport/config";
import type { DatabasePort } from "../ports/database";
import { enqueueOutbox } from "./outbox";
import { ensureSyncSchema } from "./schema";
import { createSyncScheduler } from "./scheduler";
import { betterSqliteDriver, jsonResponse } from "./test-driver";

const fetchMock = vi.fn();

function configure() {
  configureTransport({
    baseUrl: "",
    getAuthHeaders: async () => ({}),
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

/** 默认路由：空增量页 + 空 cards + feedback ok；每个请求 3ms 延迟拉开
 *  并发窗口（真 driver 上检测事务交错）。 */
function routeRequests() {
  fetchMock.mockImplementation(async (url: string) => {
    await new Promise((r) => setTimeout(r, 3));
    const u = String(url);
    if (u.includes("/sync/threads")) {
      return jsonResponse({ ok: true, rows: [], cursor: null, hasMore: false });
    }
    if (u.includes("/sync/messages")) {
      return jsonResponse({ ok: true, rows: [], cursor: 0, hasMore: false });
    }
    if (u.includes("/cards")) return jsonResponse({ cards: [] });
    if (u.includes("/feedback")) return jsonResponse({ ok: true });
    throw new Error(`unrouted: ${u}`);
  });
}

/** 包一层 driver：统计事务深度——serialize 失效时 BEGIN 会嵌套（depth>1）。 */
function trackedDriver(raw: Database.Database): { db: DatabasePort; maxDepth: () => number } {
  const inner = betterSqliteDriver(raw);
  let depth = 0;
  let max = 0;
  const db: DatabasePort = {
    run: inner.run,
    query: inner.query,
    transaction: async (fn) => {
      depth += 1;
      max = Math.max(max, depth);
      try {
        return await inner.transaction(fn);
      } finally {
        depth -= 1;
      }
    },
  };
  return { db, maxDepth: () => max };
}

afterEach(() => fetchMock.mockReset());

describe("createSyncScheduler", () => {
  it("serializes pass + concurrent doorbells — transactions never nest", async () => {
    configure();
    routeRequests();
    const raw = new Database(":memory:");
    const { db, maxDepth } = trackedDriver(raw);
    const scheduler = createSyncScheduler({ db });

    const pass = scheduler.runFullPass();
    scheduler.notifyThreadActivity("card-t1");
    scheduler.notifyThreadActivity("card-t2");
    scheduler.notifyThreadActivity("card-t1");
    await pass;
    await new Promise((r) => setTimeout(r, 80));

    expect(maxDepth()).toBe(1);
  });

  it("runs push-then-pull: queued feedback delivers before the first pull", async () => {
    configure();
    routeRequests();
    const raw = new Database(":memory:");
    const db = betterSqliteDriver(raw);
    await ensureSyncSchema(db);
    await enqueueOutbox(db, "/feedback", { kind: "dismiss" }, "k1");

    await createSyncScheduler({ db }).runFullPass();

    const order = fetchMock.mock.calls.map((c) => String(c[0]));
    const feedbackIdx = order.findIndex((u) => u.includes("/feedback"));
    const threadsIdx = order.findIndex((u) => u.includes("/sync/threads"));
    expect(feedbackIdx).toBeGreaterThanOrEqual(0);
    expect(feedbackIdx).toBeLessThan(threadsIdx);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0);
  });

  it("collapses a doorbell storm into at most two syncs (trailing merge)", async () => {
    configure();
    routeRequests();
    const scheduler = createSyncScheduler({ db: betterSqliteDriver(new Database(":memory:")) });

    for (let i = 0; i < 5; i++) scheduler.notifyThreadActivity("t1");
    await new Promise((r) => setTimeout(r, 100));

    const syncs = fetchMock.mock.calls.filter((c) => String(c[0]).includes("session=t1")).length;
    expect(syncs).toBeGreaterThanOrEqual(1);
    expect(syncs).toBeLessThanOrEqual(2);
  });

  it("fires onNewCards only for increments (bootstrap round stays silent)", async () => {
    configure();
    const card = (id: string) => ({
      card: {
        id,
        goalBasket: "personal",
        title: `t-${id}`,
        whyNow: "w",
        summary: "s",
        primaryAction: { label: "Go", type: "confirm" },
        secondaryActions: [],
        confidence: 1,
        urgency: 1,
        importance: 1,
        sources: [],
        agentChain: [],
        createdAt: "2026-06-12T00:00:00+00:00",
      },
      runId: `r-${id}`,
      runCompletedAt: "2026-06-12T00:00:00+00:00",
      score: null,
      latestOutcome: null,
      outcomeAt: null,
    });
    let cardsPayload = { cards: [card("c1")] };
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/sync/threads")) return jsonResponse({ ok: true, rows: [], cursor: null, hasMore: false });
      if (u.includes("/cards")) return jsonResponse(cardsPayload);
      return jsonResponse({ ok: true, rows: [], cursor: 0, hasMore: false });
    });
    const onNewCards = vi.fn();
    const scheduler = createSyncScheduler({
      db: betterSqliteDriver(new Database(":memory:")),
      onNewCards,
    });

    await scheduler.runFullPass();
    expect(onNewCards).not.toHaveBeenCalled(); // bootstrap 轮

    cardsPayload = { cards: [card("c1"), card("c2")] };
    await scheduler.runFullPass();
    expect(onNewCards).toHaveBeenCalledTimes(1);
    expect(onNewCards.mock.calls[0][1]).toEqual(["c2"]);
  });

  it("network failure never throws out of the pass; next pass recovers", async () => {
    configure();
    fetchMock.mockRejectedValue(new Error("offline"));
    const scheduler = createSyncScheduler({ db: betterSqliteDriver(new Database(":memory:")) });
    await expect(scheduler.runFullPass()).resolves.toBeUndefined();

    routeRequests();
    await expect(scheduler.runFullPass()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/sync/threads"))).toBe(true);
  });
});
