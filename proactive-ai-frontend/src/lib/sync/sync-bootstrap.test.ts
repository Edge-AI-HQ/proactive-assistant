/**
 * 调度契约回归：所有触库操作经全局串行队列（单连接显式 BEGIN 下并发
 * 事务会嵌套/交错——capacitor driver 的「无并发写者」契约由这里兑现）、
 * 门铃风暴 trailing 合并、per-user 库名隔离、未启动时各入口 no-op。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tracker = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  calls: [] as string[],
  async track<T>(name: string, result: T): Promise<T> {
    tracker.active += 1;
    tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
    tracker.calls.push(name);
    await new Promise((r) => setTimeout(r, 2));
    tracker.active -= 1;
    return result;
  },
}));

const createCapacitorDatabaseMock = vi.hoisted(() =>
  vi.fn(() => ({
    run: async () => {},
    // mainThreadIds → 一个 main thread，让 pass 走全链路。
    query: async () => [{ thread_id: "main-1" }],
    transaction: async <T,>(fn: (tx: unknown) => Promise<T>) =>
      fn({ run: async () => {}, query: async () => [] }),
  })),
);

vi.mock("@/lib/platform", () => ({ isNative: true }));
vi.mock("@/lib/sync/capacitor-database", () => ({
  createCapacitorDatabase: createCapacitorDatabaseMock,
}));
vi.mock("@pin-ai/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  SyncEngine: class {
    syncThreads = () => tracker.track("threads", { pulled: 0 });
    syncMessages = (tid: string) => tracker.track(`messages:${tid}`, { pulled: 1 });
    syncCards = () => tracker.track("cards", { pulled: 0 });
    stats = async () => ({});
  },
  drainOutbox: () => tracker.track("drain", { sent: 0, failed: 0, dropped: 0 }),
  enqueueOutbox: () => tracker.track("enqueue", undefined),
}));

async function freshBootstrap() {
  vi.resetModules();
  return import("./sync-bootstrap");
}

async function settle() {
  // 每个 op 2ms、总 op 数 < 20 —— 100ms 足够队列排干。
  await new Promise((r) => setTimeout(r, 100));
}

beforeEach(() => {
  tracker.active = 0;
  tracker.maxActive = 0;
  tracker.calls = [];
  createCapacitorDatabaseMock.mockClear();
});

describe("startShadowSync", () => {
  it("opens a per-user database (account isolation by construction)", async () => {
    const { startShadowSync } = await freshBootstrap();
    startShadowSync("a1b2-c3d4");
    expect(createCapacitorDatabaseMock).toHaveBeenCalledWith("pinai_sync_a1b2_c3d4");
    await settle();
  });

  it("never interleaves engine/drain operations — pass and doorbells serialize", async () => {
    const { startShadowSync, notifyThreadActivity } = await freshBootstrap();
    startShadowSync("u1");
    // 首轮 pass 进行中就按铃：两个不同 thread + 重复门铃。
    notifyThreadActivity("card-t1");
    notifyThreadActivity("card-t2");
    notifyThreadActivity("card-t1");
    await settle();

    expect(tracker.maxActive).toBe(1);
    // pass 全链路跑完（push-then-pull：drain 在拉取前）。
    const passOrder = ["drain", "threads", "messages:main-1", "cards"];
    const passCalls = tracker.calls.filter((c) => passOrder.includes(c));
    expect(passCalls.slice(0, 4)).toEqual(passOrder);
  });

  it("collapses a doorbell storm into at most two syncs (trailing merge)", async () => {
    const { startShadowSync, notifyThreadActivity } = await freshBootstrap();
    startShadowSync("u1");
    await settle(); // 首轮 pass 排干，隔离计数
    const before = tracker.calls.filter((c) => c === "messages:t1").length;
    for (let i = 0; i < 5; i++) notifyThreadActivity("t1");
    await settle();
    const storms = tracker.calls.filter((c) => c === "messages:t1").length - before;
    expect(storms).toBeGreaterThanOrEqual(1);
    expect(storms).toBeLessThanOrEqual(2);
  });
});

describe("before start (web / signed-out)", () => {
  it("all entry points are safe no-ops", async () => {
    const mod = await freshBootstrap();
    expect(await mod.enqueueFeedback({ kind: "dismiss" })).toBe(false);
    expect(await mod.readLocalHistory("main-1")).toBeNull();
    expect(await mod.searchLocal("passport")).toEqual({ messages: [], cards: [] });
    mod.notifyThreadActivity("main-1");
    await settle();
    expect(tracker.calls).toEqual([]);
  });
});
