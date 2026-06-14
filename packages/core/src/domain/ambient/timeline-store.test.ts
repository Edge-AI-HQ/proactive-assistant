import { describe, expect, test } from "vitest";

import { MemoryTimelineStore } from "./timeline-store";
import {
  AMBIENT_TIMELINE_SCHEMA_VERSION,
  type AmbientCandidateWindow,
  type AmbientRawEvent,
  type AmbientTimelineEvent,
} from "./types";
import { DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE } from "./summary-scheduler";

function rawEvent(overrides: Partial<AmbientRawEvent> = {}): AmbientRawEvent {
  return {
    id: "raw_1",
    localUserId: "local",
    deviceId: null,
    sourceType: "health",
    eventType: "health.summary",
    sourceVersion: "v1",
    occurredAt: "2026-05-15T10:00:00.000Z",
    collectedAt: "2026-05-15T10:00:01.000Z",
    timezone: "UTC",
    localDate: "2026-05-15",
    payload: { metric: "steps" },
    compactText: "compact",
    confidence: null,
    sensitivity: "normal",
    permissionState: null,
    ttlExpiresAt: null,
    contentHash: "hash",
    dedupeKey: "dedupe_1",
    processingStatus: "new",
    createdAt: "2026-05-15T10:00:01.000Z",
    updatedAt: "2026-05-15T10:00:01.000Z",
    ...overrides,
  };
}

function candidateWindow(
  overrides: Partial<AmbientCandidateWindow> = {},
): AmbientCandidateWindow {
  return {
    id: "win_1",
    localUserId: "local",
    localDate: "2026-05-15",
    windowType: "morning_health",
    startedAt: "2026-05-15T08:00:00.000Z",
    timezone: "UTC",
    sourceTypes: ["health"],
    deviceLabels: ["iPhone"],
    rawRefs: [{ sourceType: "health", id: "raw_1" }],
    observationIds: [],
    compactContext: "morning",
    privacyHint: "normal",
    confidenceHint: 0.8,
    salienceHint: 0.5,
    generationPolicy: "llm_allowed",
    llmInputHash: null,
    status: "pending",
    lastAttemptAt: null,
    attemptCount: 0,
    lastErrorCode: null,
    expiresAt: null,
    createdAt: "2026-05-15T08:00:01.000Z",
    updatedAt: "2026-05-15T08:00:01.000Z",
    ...overrides,
  };
}

function timelineEvent(
  overrides: Partial<AmbientTimelineEvent> = {},
): AmbientTimelineEvent {
  return {
    id: "evt_1",
    localUserId: "local",
    localDate: "2026-05-15",
    timezone: "UTC",
    occurredAt: "2026-05-15T09:00:00.000Z",
    eventType: "morning",
    title: "Morning",
    summary: "A calm morning",
    primarySourceLabel: "HealthKit",
    deviceLabels: ["iPhone"],
    sourceTypes: ["health"],
    tags: ["calm"],
    privacy: "normal",
    confidence: 0.9,
    confidenceLabel: "certain",
    salience: 0.6,
    rawRefs: [{ sourceType: "health", id: "raw_1" }],
    observationIds: [],
    generationMethod: "rule",
    generationStatus: "visible",
    memoryCandidate: false,
    cardTriggerCandidate: false,
    schemaVersion: AMBIENT_TIMELINE_SCHEMA_VERSION,
    syncStatus: "local_only",
    dedupeKey: "evt_dedupe_1",
    createdAt: "2026-05-15T09:00:01.000Z",
    updatedAt: "2026-05-15T09:00:01.000Z",
    ...overrides,
  };
}

describe("MemoryTimelineStore", () => {
  test("initializes lazily and reports memory status", async () => {
    const store = new MemoryTimelineStore();

    expect(store.status()).toEqual({ mode: "memory", ready: false, lastError: null });
    await store.init();
    expect(store.status()).toEqual({ mode: "memory", ready: true, lastError: null });
  });

  test("deduplicates raw events by dedupeKey, keeping the original id", async () => {
    const store = new MemoryTimelineStore();

    await store.upsertRawEvent(rawEvent({ id: "raw_a", dedupeKey: "same" }));
    await store.upsertRawEvent(
      rawEvent({ id: "raw_b", dedupeKey: "same", compactText: "updated" }),
    );

    const rows = await store.listRawEvents({ localDate: "2026-05-15" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("raw_a");
    expect(rows[0]?.compactText).toBe("updated");
  });

  test("clones raw events so stored payloads are isolated from callers", async () => {
    const store = new MemoryTimelineStore();
    const input = rawEvent();

    const stored = await store.upsertRawEvent(input);
    stored.payload.metric = "mutated";

    const rows = await store.listRawEvents({});
    expect(rows[0]?.payload.metric).toBe("steps");
  });

  test("filters raw events by source type and honors descending order", async () => {
    const store = new MemoryTimelineStore();
    await store.upsertRawEvent(
      rawEvent({ id: "h", dedupeKey: "h", sourceType: "health", occurredAt: "2026-05-15T10:00:00.000Z" }),
    );
    await store.upsertRawEvent(
      rawEvent({ id: "loc", dedupeKey: "loc", sourceType: "location", occurredAt: "2026-05-15T11:00:00.000Z" }),
    );

    const onlyHealth = await store.listRawEvents({ sourceType: "health" });
    expect(onlyHealth.map((row) => row.id)).toEqual(["h"]);

    const desc = await store.listRawEvents({ order: "desc" });
    expect(desc.map((row) => row.id)).toEqual(["loc", "h"]);
  });

  test("upserts candidate windows and derives summaryStatus", async () => {
    const store = new MemoryTimelineStore();

    const stored = await store.upsertCandidateWindow(candidateWindow({ status: "generated" }));
    expect(stored.summaryStatus).toBe("summarized");

    const pending = await store.listCandidateWindows({ summaryStatus: "summarized" });
    expect(pending.map((row) => row.id)).toEqual(["win_1"]);
  });

  test("inserts a timeline event and reports it should sync", async () => {
    const store = new MemoryTimelineStore();

    const result = await store.upsertTimelineEvent(timelineEvent());
    expect(result.shouldSync).toBe(true);
    expect(result.event.generationSource).toBe("rule_based");

    const visible = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });
    expect(visible.map((row) => row.id)).toEqual(["evt_1"]);
  });

  test("flips a previously synced event back to pending when visible payload changes", async () => {
    const store = new MemoryTimelineStore();
    await store.upsertTimelineEvent(timelineEvent({ syncStatus: "synced" }));

    const result = await store.upsertTimelineEvent(
      timelineEvent({ syncStatus: "synced", title: "New title" }),
    );

    expect(result.event.syncStatus).toBe("pending");
    expect(result.shouldSync).toBe(true);
  });

  test("never resurrects a hidden timeline event", async () => {
    const store = new MemoryTimelineStore();
    await store.upsertTimelineEvent(timelineEvent());
    await store.dismissTimelineEvent("evt_1");

    const result = await store.upsertTimelineEvent(
      timelineEvent({ title: "Try to revive", generationStatus: "visible" }),
    );

    expect(result.shouldSync).toBe(false);
    expect(result.event.generationStatus).toBe("hidden");
    const visible = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });
    expect(visible).toHaveLength(0);
  });

  test("marks selected timeline events as synced", async () => {
    const store = new MemoryTimelineStore();
    await store.upsertTimelineEvent(timelineEvent({ id: "evt_1", dedupeKey: "d1" }));
    await store.upsertTimelineEvent(timelineEvent({ id: "evt_2", dedupeKey: "d2" }));

    await store.markTimelineEventsSynced(["evt_1"]);

    const rows = await store.listTimelineEvents("2026-05-15");
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.syncStatus]));
    expect(byId.evt_1).toBe("synced");
    expect(byId.evt_2).toBe("local_only");
  });

  test("persists summary scheduler state, defaulting before any write", async () => {
    const store = new MemoryTimelineStore();

    expect(await store.getSummarySchedulerState()).toEqual(
      DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
    );

    await store.setSummarySchedulerState({
      ...DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
      lastSummarySuccessAt: "2026-05-19T10:00:00.000Z",
      retryCount: 2,
    });

    expect(await store.getSummarySchedulerState()).toMatchObject({
      lastSummarySuccessAt: "2026-05-19T10:00:00.000Z",
      retryCount: 2,
    });
  });
});
