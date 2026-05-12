import { beforeEach, describe, expect, test, vi } from "vitest";

import { MemoryOutboxStore } from "./outbox";
import { AmbientSyncScheduler } from "./sync-scheduler";

vi.mock("./ingest-bridge", () => ({
  ingestBatch: vi.fn(),
}));

import { ingestBatch } from "./ingest-bridge";

const mockedIngestBatch = ingestBatch as unknown as ReturnType<typeof vi.fn>;
const now = Date.parse("2026-05-11T12:00:00.000Z");

describe("AmbientSyncScheduler", () => {
  beforeEach(() => {
    mockedIngestBatch.mockReset();
  });

  test("does not call ingest when outbox is empty", async () => {
    const outbox = new MemoryOutboxStore();
    const scheduler = new AmbientSyncScheduler(outbox);

    const result = await scheduler.drain();

    expect(result.attempted).toBe(0);
    expect(mockedIngestBatch).not.toHaveBeenCalled();
  });

  test("marks acknowledged records as synced", async () => {
    mockedIngestBatch.mockResolvedValueOnce({
      ok: true,
      accepted: 1,
      inserted: 1,
      ignored: 0,
      results: [{ id: "item-1", dedupe_key: "audio:1", status: "inserted" }],
    });
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "item-1",
        kind: "session_summary",
        title: "Voice summary",
        summary: "A useful transcript that should upload.",
        dedupe_key: "audio:1",
      },
    ]);
    const scheduler = new AmbientSyncScheduler(outbox);

    const result = await scheduler.drain();

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.syncedItems).toHaveLength(1);
    expect(await outbox.count()).toBe(0);
  });

  test("keeps unacknowledged records for retry", async () => {
    mockedIngestBatch.mockResolvedValueOnce({
      ok: true,
      accepted: 1,
      inserted: 0,
      ignored: 1,
      results: [],
    });
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "item-2",
        kind: "device.location",
        title: "Location",
        summary: "location",
        dedupe_key: "loc:1",
      },
    ]);
    const scheduler = new AmbientSyncScheduler(outbox);

    const result = await scheduler.drain();

    expect(result.synced).toBe(0);
    expect(result.failed).toBe(1);
    expect(await outbox.count()).toBe(1);
  });

  test("marks batch failed when ingest throws", async () => {
    mockedIngestBatch.mockRejectedValueOnce(new Error("network down"));
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "item-3",
        kind: "device.activity",
        title: "Activity",
        summary: "walking",
        dedupe_key: "activity:1",
      },
    ]);
    const scheduler = new AmbientSyncScheduler(outbox, { maxRetryDelayMs: 15 * 60_000 });

    const result = await scheduler.drain();

    expect(result.failed).toBe(1);
    const status = scheduler.status();
    expect(status.lastError).toBe("network down");
    const retryable = await outbox.pending(1, Date.now() + 20_000);
    expect(retryable[0]?.attemptCount).toBe(1);
    expect(retryable[0]?.lastError).toBe("network down");
  });
});
