import { beforeEach, describe, expect, test, vi } from "vitest";

import { MemoryOutboxStore } from "./outbox";
import { AmbientSyncScheduler } from "./sync-scheduler";
import { AMBIENT_LOCATION_UPDATE_KIND, AMBIENT_TIMELINE_KIND, AMBIENT_VISIT_EVENT_KIND } from "./timeline";

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
        kind: AMBIENT_TIMELINE_KIND,
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
        kind: AMBIENT_TIMELINE_KIND,
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

  test("short-circuits drain when uploads are globally locked", async () => {
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "item-lock",
        kind: AMBIENT_TIMELINE_KIND,
        title: "Locked",
        summary: "should stay queued while uploads are locked",
        dedupe_key: "audio:lock",
      },
    ]);
    const scheduler = new AmbientSyncScheduler(outbox);
    scheduler.setUploadsLocked(true);

    const result = await scheduler.drain();

    expect(result.attempted).toBe(0);
    expect(result.synced).toBe(0);
    expect(mockedIngestBatch).not.toHaveBeenCalled();
    expect(await outbox.count()).toBe(1);
    const status = scheduler.status();
    expect(status.uploadsLocked).toBe(true);
    expect(status.lastDrainTs).not.toBeNull();
    expect(status.lastSuccessTs).toBeNull();
  });

  test("resumes draining after uploads are unlocked", async () => {
    mockedIngestBatch.mockResolvedValueOnce({
      ok: true,
      accepted: 1,
      inserted: 1,
      ignored: 0,
      results: [{ id: "item-unlock", dedupe_key: "audio:unlock", status: "inserted" }],
    });
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "item-unlock",
        kind: AMBIENT_TIMELINE_KIND,
        title: "Unlock",
        summary: "should upload once the lock is released",
        dedupe_key: "audio:unlock",
      },
    ]);
    const scheduler = new AmbientSyncScheduler(outbox);
    scheduler.setUploadsLocked(true);
    await scheduler.drain();
    expect(mockedIngestBatch).not.toHaveBeenCalled();

    scheduler.setUploadsLocked(false);
    const result = await scheduler.drain();

    expect(result.synced).toBe(1);
    expect(await outbox.count()).toBe(0);
    expect(scheduler.status().uploadsLocked).toBe(false);
  });

  test("marks batch failed when ingest throws", async () => {
    mockedIngestBatch.mockRejectedValueOnce(new Error("network down"));
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "item-3",
        kind: AMBIENT_TIMELINE_KIND,
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

  test("drops local-only raw source records instead of uploading them", async () => {
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "raw-location",
        kind: "device.location",
        title: "Location",
        summary: "precise local raw signal",
        dedupe_key: "location:raw",
      },
    ]);
    const scheduler = new AmbientSyncScheduler(outbox);

    const result = await scheduler.drain();

    expect(mockedIngestBatch).not.toHaveBeenCalled();
    expect(result.ignored).toBe(1);
    expect(await outbox.count()).toBe(0);
  });

  test("uploads sanitized ambient location and visit evidence records", async () => {
    mockedIngestBatch.mockResolvedValueOnce({
      ok: true,
      accepted: 2,
      inserted: 2,
      ignored: 0,
      results: [
        { id: "loc-upload", dedupe_key: "ambient:location_update:1", status: "inserted" },
        { id: "visit-upload", dedupe_key: "ambient:visit_event:1", status: "inserted" },
      ],
    });
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "loc-upload",
        kind: AMBIENT_LOCATION_UPDATE_KIND,
        title: "Location update",
        summary: "Location updated near Mission District around 2:05 PM.",
        dedupe_key: "ambient:location_update:1",
      },
      {
        id: "visit-upload",
        kind: AMBIENT_VISIT_EVENT_KIND,
        title: "Visit event",
        summary: "Visit signals indicate arrival near Ferry Building around 4:10 PM.",
        dedupe_key: "ambient:visit_event:1",
      },
    ]);
    const scheduler = new AmbientSyncScheduler(outbox);

    const result = await scheduler.drain();

    expect(result.synced).toBe(2);
    expect(mockedIngestBatch).toHaveBeenCalledWith([
      expect.objectContaining({ kind: AMBIENT_LOCATION_UPDATE_KIND }),
      expect.objectContaining({ kind: AMBIENT_VISIT_EVENT_KIND }),
    ]);
    expect(await outbox.count()).toBe(0);
  });

});
