import { describe, expect, test, vi } from "vitest";

import { maybeRunScheduledAmbientSummary } from "./scheduled-summary";
import { DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE } from "./summary-scheduler";
import type { AmbientTimelineStore } from "./types";

function store(): AmbientTimelineStore {
  const state = { current: DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE };
  return {
    kind: "memory",
    init: vi.fn(async () => {}),
    status: vi.fn(() => ({ mode: "memory", ready: true, lastError: null })),
    upsertRawEvent: vi.fn(),
    listRawEvents: vi.fn(async () => []),
    getRawEventsByRefs: vi.fn(async () => []),
    listRawEventsInRange: vi.fn(async () => []),
    upsertCandidateWindow: vi.fn(),
    listCandidateWindows: vi.fn(async () => []),
    upsertTimelineEvent: vi.fn(async (event) => ({ event, shouldSync: true })),
    listTimelineEvents: vi.fn(async () => []),
    listTimelineEventsByGenerationSource: vi.fn(async () => []),
    dismissTimelineEvent: vi.fn(async () => {}),
    markTimelineEventsSynced: vi.fn(async () => {}),
    getSummarySchedulerState: vi.fn(async () => state.current),
    setSummarySchedulerState: vi.fn(async (next) => { state.current = next; }),
  } as unknown as AmbientTimelineStore;
}

describe("maybeRunScheduledAmbientSummary", () => {
  test("creates an other-typed local LLM summary from all raw context", async () => {
    const timelineStore = store();
    vi.mocked(timelineStore.listRawEventsInRange).mockResolvedValue([
      raw("motion_1", "motion", "Walking for 12 minutes"),
      raw("location_1", "location", "Arrived at office"),
    ]);
    const bridge = {
      generateAmbientSummaryEvent: vi.fn(async () => ({
        ok: true as const,
        draft: {
          title: "Office arrival",
          summary: "You walked to the office and arrived around 10 AM.",
          tags: ["location", "motion"],
          confidence: 0.8,
          confidenceLabel: "certain" as const,
        },
        modelId: "gemma-2-2b-q4",
      })),
    };

    const result = await maybeRunScheduledAmbientSummary({
      store: timelineStore,
      bridge,
      now: new Date("2026-05-19T10:15:00.000Z"),
      localDate: "2026-05-19",
      timezone: "UTC",
      localUserId: "local",
    });

    expect(result).toEqual({ ran: true, status: "success" });
    expect(bridge.generateAmbientSummaryEvent).toHaveBeenCalledWith(expect.objectContaining({
      rawEvents: expect.arrayContaining([
        expect.objectContaining({ sourceType: "motion" }),
        expect.objectContaining({ sourceType: "location" }),
      ]),
    }));
    expect(timelineStore.upsertTimelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "other",
      generationMethod: "local_llm",
      generationSource: "llm_summary",
      title: "Office arrival",
    }));
  });
});

function raw(id: string, sourceType: "motion" | "location", compactText: string): import("./types").AmbientRawEvent {
  return {
    id,
    localUserId: "local",
    deviceId: "phone",
    sourceType,
    eventType: `${sourceType}.event`,
    sourceVersion: "v1",
    occurredAt: "2026-05-19T10:00:00.000Z",
    collectedAt: "2026-05-19T10:00:01.000Z",
    timezone: "UTC",
    localDate: "2026-05-19",
    payload: {},
    compactText,
    confidence: null,
    sensitivity: "normal" as const,
    permissionState: null,
    ttlExpiresAt: null,
    contentHash: id,
    dedupeKey: id,
    processingStatus: "new" as const,
    createdAt: "2026-05-19T10:00:01.000Z",
    updatedAt: "2026-05-19T10:00:01.000Z",
  };
}
