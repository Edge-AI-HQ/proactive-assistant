import { describe, expect, test } from "vitest";

import type { PersonalSignalInput } from "../domain/signals";
import { MemoryOutboxStore } from "./ambient-outbox";
import { stableHash } from "../domain/ambient/utils";

const now = Date.parse("2026-05-11T12:00:00.000Z");

function transcriptCandidate(
  rawRefCount: number,
  contentHash: string,
  summary: string,
): PersonalSignalInput {
  return {
    id: `candidate-${contentHash}`,
    kind: "ambient.candidate_window",
    title: "Ambient transcript_session window",
    summary,
    dedupe_key: `legacy:${contentHash}`,
    occurred_at: "2026-05-11T11:00:00.000Z",
    payload: {
      window_type: "transcript_session",
      local_date: "2026-05-11",
      local_window_id: "win-transcript",
      raw_ref_count: rawRefCount,
      content_hash: contentHash,
      compact_context: summary,
    },
  };
}

describe("MemoryOutboxStore", () => {
  test("dedupes records by dedupe_key", async () => {
    const outbox = new MemoryOutboxStore();

    const inserted = await outbox.enqueue([
      {
        kind: "session_summary",
        title: "Voice summary",
        summary: "first",
        dedupe_key: "audio:1",
      },
      {
        kind: "session_summary",
        title: "Voice summary",
        summary: "duplicate",
        dedupe_key: "audio:1",
      },
    ]);

    expect(inserted).toBe(1);
    expect(await outbox.count()).toBe(1);
  });

  test("selects only available non-expired pending records", async () => {
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        kind: "device.location",
        title: "ready",
        summary: "ready",
        occurred_at: "2026-05-11T11:59:00.000Z",
        available_at: "2026-05-11T11:59:30.000Z",
        expires_at: "2026-05-11T12:01:00.000Z",
        dedupe_key: "ready",
      },
      {
        kind: "device.location",
        title: "future",
        summary: "future",
        available_at: "2026-05-11T12:10:00.000Z",
        dedupe_key: "future",
      },
      {
        kind: "device.location",
        title: "expired",
        summary: "expired",
        expires_at: "2026-05-11T11:59:00.000Z",
        dedupe_key: "expired",
      },
    ]);

    const pending = await outbox.pending(10, now);

    expect(pending.map((row) => row.dedupeKey)).toEqual(["ready"]);
  });

  test("marks failures with retry metadata and hides them until retry time", async () => {
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        kind: "device.activity",
        title: "Activity",
        summary: "walking",
        dedupe_key: "activity:1",
        // Pin occurred_at — without it, MemoryOutboxStore.enqueue uses
        // Date.now() which drifts past the test's frozen `now` and makes
        // `pending(now)` see the row as "not yet available".
        occurred_at: "2026-05-11T11:00:00.000Z",
      },
    ]);
    const [record] = await outbox.pending(1, now);

    await outbox.markFailed([record.id], "offline", now + 60_000);

    expect(await outbox.pending(1, now)).toEqual([]);
    const retryable = await outbox.pending(1, now + 60_000);
    expect(retryable[0]?.attemptCount).toBe(1);
    expect(retryable[0]?.lastError).toBe("offline");
  });

  test("clears retry state when records are synced", async () => {
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        kind: "device.visit",
        title: "Visit",
        summary: "arrived",
        dedupe_key: "visit:1",
        occurred_at: "2026-05-11T11:00:00.000Z",
      },
    ]);
    const [record] = await outbox.pending(1, now);

    await outbox.markFailed([record.id], "offline", now);
    await outbox.markSynced([record.id], now + 1);

    expect(await outbox.count()).toBe(0);
    expect(await outbox.pending(1, now + 1)).toEqual([]);
  });

  test("synced rows become pending again for a different signed-in user", async () => {
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "health-1",
        kind: "ambient.timeline_event",
        title: "Health",
        summary: "steps",
        dedupe_key: "health:steps:today",
        occurred_at: "2026-05-11T11:00:00.000Z",
      },
    ]);

    await outbox.markSynced(["health-1"], now, "old-user");

    expect(await outbox.count("old-user")).toBe(0);
    expect(await outbox.pending(10, now + 1, "old-user")).toEqual([]);
    expect(await outbox.count("new-user")).toBe(1);
    expect((await outbox.pending(10, now + 1, "new-user"))[0]?.id).toBe("health-1");

    await outbox.markSynced(["health-1"], now + 2, "new-user");
    expect(await outbox.count("new-user")).toBe(0);
  });

  test("synced rows become pending again for a different backend", async () => {
    const outbox = new MemoryOutboxStore();
    await outbox.enqueue([
      {
        id: "health-2",
        kind: "ambient.timeline_event",
        title: "Health",
        summary: "steps",
        dedupe_key: "health:steps:backend",
        occurred_at: "2026-05-11T11:00:00.000Z",
      },
    ]);

    await outbox.markSynced(["health-2"], now, "user-a", "https://local.example");

    expect(await outbox.count("user-a", "https://local.example")).toBe(0);
    expect(await outbox.count("user-a", "https://dev.example")).toBe(1);
    expect((await outbox.pending(10, now + 1, "user-a", "https://dev.example"))[0]?.id).toBe("health-2");
  });

  test("upserts transcript candidate windows to the latest local row", async () => {
    const outbox = new MemoryOutboxStore();

    expect(await outbox.enqueue([
      transcriptCandidate(1, "hash-1", "first transcript chunk"),
    ])).toBe(1);
    expect(await outbox.enqueue([
      transcriptCandidate(5, "hash-5", "five transcript chunks"),
    ])).toBe(1);
    expect(await outbox.enqueue([
      transcriptCandidate(3, "hash-3", "stale transcript chunks"),
    ])).toBe(0);

    const pending = await outbox.pending(10, now);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dedupeKey).toBe(
      "ambient:candidate_window:2026-05-11:transcript_session:win-transcript",
    );
    expect(pending[0]?.item.dedupe_key).toBe(pending[0]?.dedupeKey);
    expect(pending[0]?.item.summary).toBe("five transcript chunks");
    expect(pending[0]?.item.payload?.raw_ref_count).toBe(5);
  });

  test("fresh transcript candidate content makes a synced row pending again", async () => {
    const outbox = new MemoryOutboxStore();

    await outbox.enqueue([transcriptCandidate(1, "hash-1", "first")]);
    const [record] = await outbox.pending(1, now);
    await outbox.markSynced([record.id], now, "user-a", "https://dev.example");

    expect(await outbox.count("user-a", "https://dev.example")).toBe(0);
    expect(await outbox.enqueue([transcriptCandidate(2, "hash-2", "fresh")])).toBe(1);

    const pending = await outbox.pending(1, now + 1, "user-a", "https://dev.example");
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.syncedAt).toBeNull();
    expect(pending[0]?.attemptCount).toBe(0);
    expect(pending[0]?.item.summary).toBe("fresh");
  });

  test("stores transcript candidate summaries without segment labels", async () => {
    const outbox = new MemoryOutboxStore();

    await outbox.enqueue([
      transcriptCandidate(
        2,
        "hash-labeled",
        "Transcript segment: first chunk Transcript segment: second chunk",
      ),
    ]);

    const [record] = await outbox.pending(1, now);
    expect(record.item.summary).toBe("first chunk second chunk");
    expect(record.item.payload?.compact_context).toBe("first chunk second chunk");
    expect(record.item.payload?.content_hash).toBe(stableHash("first chunk second chunk"));
  });
});
