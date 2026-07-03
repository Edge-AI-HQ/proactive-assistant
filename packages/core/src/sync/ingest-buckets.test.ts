import { describe, expect, test } from "vitest";

import type { IngestResult } from "../domain/signals";
import type { OutboxRecord } from "./ambient-outbox";
import { SYNCABLE_AMBIENT_KINDS, bucketRecords, retryDelayMs } from "./ingest-buckets";

function record(id: string, attemptCount = 0): OutboxRecord {
  return {
    id,
    item: { id, kind: "ambient.timeline_event", title: "t", summary: "s" },
    dedupeKey: `k:${id}`,
    status: "pending",
    attemptCount,
    lastError: null,
    nextRetryAt: null,
    insertedAt: 0,
    updatedAt: 0,
    syncedAt: null,
    syncedOwnerUserId: null,
    syncedBackendUrl: null,
  };
}

function stats(results: IngestResult["results"]): IngestResult {
  return { ok: true, accepted: results?.length ?? 0, inserted: 0, ignored: 0, results };
}

describe("SYNCABLE_AMBIENT_KINDS", () => {
  test("whitelists only distilled pipeline kinds", () => {
    expect(SYNCABLE_AMBIENT_KINDS.has("ambient.timeline_event")).toBe(true);
    expect(SYNCABLE_AMBIENT_KINDS.has("ambient.candidate_window")).toBe(true);
    expect(SYNCABLE_AMBIENT_KINDS.has("health.observation")).toBe(true);
    expect(SYNCABLE_AMBIENT_KINDS.has("device.location")).toBe(false);
    expect(SYNCABLE_AMBIENT_KINDS.has("session_summary")).toBe(false);
  });
});

describe("bucketRecords", () => {
  test("missing results → everything retryable (defensive branch)", () => {
    const records = [record("a"), record("b")];
    const out = bucketRecords(records, { ok: false, accepted: 0, inserted: 0, ignored: 0 });
    expect(out.settledIds).toEqual([]);
    expect(out.retryableIds).toEqual(["a", "b"]);
    expect(out.rejectedDetails).toEqual([]);
  });

  test("classifies the six per-item statuses into three buckets", () => {
    const records = [
      record("ins"), record("dup"), record("fil"),
      record("rej"), record("par"), record("ret"), record("unack"),
    ];
    const out = bucketRecords(records, stats([
      { id: "ins", dedupeKey: null, status: "inserted" },
      { id: "dup", dedupeKey: null, status: "duplicate" },
      { id: "fil", dedupeKey: null, status: "filtered" },
      { id: "rej", dedupeKey: null, status: "rejected", reason: "bad payload" },
      { id: "par", dedupeKey: null, status: "parse_failed" },
      { id: "ret", dedupeKey: null, status: "retryable_failed" },
      // "unack" intentionally absent from results.
    ]));
    expect(out.settledIds).toEqual(["ins", "dup", "fil", "rej", "par"]);
    expect(out.retryableIds).toEqual(["ret", "unack"]);
    expect(out.rejectedDetails).toEqual([
      { id: "rej", status: "rejected", reason: "bad payload" },
      { id: "par", status: "parse_failed", reason: undefined },
    ]);
  });
});

describe("retryDelayMs", () => {
  test("doubles per attempt from a 10s floor", () => {
    const max = 15 * 60_000;
    expect(retryDelayMs([record("a", 0)], max)).toBe(10_000); // 2^1 * 5s
    expect(retryDelayMs([record("a", 1)], max)).toBe(20_000); // 2^2 * 5s
    expect(retryDelayMs([record("a", 2), record("b", 4)], max)).toBe(160_000); // max attempt wins
  });

  test("caps at maxRetryDelayMs", () => {
    expect(retryDelayMs([record("a", 20)], 15 * 60_000)).toBe(15 * 60_000);
  });
});
