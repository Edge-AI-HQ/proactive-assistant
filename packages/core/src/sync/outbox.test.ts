/**
 * Outbox 契约：dedupe 幂等入队、成功即删、网络/5xx 失败指数退避、
 * 4xx 协议性失败与 TTL 过期永久放弃（dropped）。
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureTransport } from "../transport/config";
import { ensureSyncSchema } from "./schema";
import { drainOutbox, enqueueOutbox } from "./outbox";
import { betterSqliteDriver, jsonResponse } from "./test-driver";

const fetchMock = vi.fn();

async function setup() {
  configureTransport({
    baseUrl: "",
    getAuthHeaders: async () => ({}),
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  const raw = new Database(":memory:");
  const db = betterSqliteDriver(raw);
  await ensureSyncSchema(db);
  return { raw, db };
}

afterEach(() => fetchMock.mockReset());

describe("enqueueOutbox", () => {
  it("is idempotent per dedupe key; null keys never collide", async () => {
    const { raw, db } = await setup();
    await enqueueOutbox(db, "/feedback", { a: 1 }, "fb:confirm:c1");
    await enqueueOutbox(db, "/feedback", { a: 2 }, "fb:confirm:c1");
    await enqueueOutbox(db, "/feedback", { t: "x" });
    await enqueueOutbox(db, "/feedback", { t: "y" });
    const n = raw.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    expect(n.n).toBe(3);
  });
});

describe("drainOutbox", () => {
  it("delivers pending entries in order and deletes on success", async () => {
    const { raw, db } = await setup();
    await enqueueOutbox(db, "/feedback", { kind: "dismiss" }, "k1");
    await enqueueOutbox(db, "/feedback", { kind: "snooze" }, "k2");
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    expect(await drainOutbox(db)).toEqual({ sent: 2, failed: 0, dropped: 0 });
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).kind).toBe("dismiss");
    expect((raw.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0);
  });

  it("backs off on network failure and skips until next_retry_at", async () => {
    const { raw, db } = await setup();
    await enqueueOutbox(db, "/feedback", { a: 1 }, "k1");
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    expect(await drainOutbox(db)).toEqual({ sent: 0, failed: 1, dropped: 0 });
    const row = raw
      .prepare("SELECT attempt_count, last_error, next_retry_at FROM outbox")
      .get() as { attempt_count: number; last_error: string; next_retry_at: number };
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toBe("offline");
    expect(row.next_retry_at).toBeGreaterThan(Date.now());

    // 未到期：不再尝试投递。
    expect(await drainOutbox(db)).toEqual({ sent: 0, failed: 0, dropped: 0 });
    expect(fetchMock.mock.calls.length).toBe(1);

    // 到期后重试成功 → 行删除。
    raw.prepare("UPDATE outbox SET next_retry_at = 0").run();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    expect(await drainOutbox(db)).toEqual({ sent: 1, failed: 0, dropped: 0 });
    expect((raw.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0);
  });

  it("treats 5xx as retryable and 4xx as a permanent drop", async () => {
    const { raw, db } = await setup();
    await enqueueOutbox(db, "/feedback", { a: 1 }, "k-5xx");
    await enqueueOutbox(db, "/feedback", { a: 2 }, "k-4xx");
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
      .mockResolvedValueOnce({ ok: false, status: 422 } as unknown as Response);

    expect(await drainOutbox(db)).toEqual({ sent: 0, failed: 1, dropped: 1 });
    const rows = raw.prepare("SELECT dedupe_key, last_error FROM outbox").all() as Array<{
      dedupe_key: string;
      last_error: string;
    }>;
    expect(rows).toEqual([{ dedupe_key: "k-5xx", last_error: "HTTP 503" }]);
  });

  it("gives up on entries older than the TTL without calling the network", async () => {
    const { raw, db } = await setup();
    await enqueueOutbox(db, "/feedback", { a: 1 }, "k1");
    raw.prepare("UPDATE outbox SET created_at = ?").run(Date.now() - 8 * 24 * 60 * 60 * 1000);

    expect(await drainOutbox(db)).toEqual({ sent: 0, failed: 0, dropped: 1 });
    expect(fetchMock.mock.calls.length).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0);
  });
});
