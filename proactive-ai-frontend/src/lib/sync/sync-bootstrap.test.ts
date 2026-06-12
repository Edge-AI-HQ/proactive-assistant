/**
 * 平台壳契约（调度逻辑的测试在 @pin-ai/core 的 scheduler.test.ts）：
 * per-user 库名与 driver 选择、启动即跑首轮 pass、平台通知钩子接线、
 * 未启动时各入口安全 no-op。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMock = vi.hoisted(() => ({
  runFullPass: vi.fn(async () => {}),
  notifyThreadActivity: vi.fn(),
  enqueueFeedback: vi.fn(async () => true),
  readLocalHistory: vi.fn(async () => null),
  searchLocal: vi.fn(async () => ({ messages: [], cards: [] })),
}));
const createSyncSchedulerMock = vi.hoisted(() => vi.fn(() => schedulerMock));
const createCapacitorDatabaseMock = vi.hoisted(() => vi.fn(() => ({ kind: "capacitor" })));

vi.mock("@/lib/platform", () => ({ isNative: true, isElectron: false }));
vi.mock("@/lib/sync/capacitor-database", () => ({
  createCapacitorDatabase: createCapacitorDatabaseMock,
}));
vi.mock("@pin-ai/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createSyncScheduler: createSyncSchedulerMock,
}));

async function freshBootstrap() {
  vi.resetModules();
  return import("./sync-bootstrap");
}

beforeEach(() => {
  createSyncSchedulerMock.mockClear();
  createCapacitorDatabaseMock.mockClear();
  schedulerMock.runFullPass.mockClear();
  schedulerMock.notifyThreadActivity.mockClear();
});

describe("startShadowSync", () => {
  it("opens a per-user database and starts the first pass", async () => {
    const { startShadowSync } = await freshBootstrap();
    startShadowSync("a1b2-c3d4");
    expect(createCapacitorDatabaseMock).toHaveBeenCalledWith("pinai_sync_a1b2_c3d4");
    expect(createSyncSchedulerMock).toHaveBeenCalledTimes(1);
    expect(schedulerMock.runFullPass).toHaveBeenCalledTimes(1);
  });

  it("is idempotent per user and refuses an in-process user switch", async () => {
    const { startShadowSync } = await freshBootstrap();
    startShadowSync("u1");
    startShadowSync("u1");
    startShadowSync("u2"); // 不应重建到另一个用户的库
    expect(createSyncSchedulerMock).toHaveBeenCalledTimes(1);
  });

  it("forwards doorbells to the scheduler once started", async () => {
    const mod = await freshBootstrap();
    mod.startShadowSync("u1");
    mod.notifyThreadActivity("main-1");
    expect(schedulerMock.notifyThreadActivity).toHaveBeenCalledWith("main-1");
  });
});

describe("before start (web / signed-out)", () => {
  it("all entry points are safe no-ops", async () => {
    const mod = await freshBootstrap();
    expect(await mod.enqueueFeedback({ kind: "dismiss" })).toBe(false);
    expect(await mod.readLocalHistory("main-1")).toBeNull();
    expect(await mod.searchLocal("passport")).toEqual({ messages: [], cards: [] });
    mod.notifyThreadActivity("main-1");
    expect(schedulerMock.notifyThreadActivity).not.toHaveBeenCalled();
  });
});
