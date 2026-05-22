import { describe, expect, test, vi } from "vitest";

import { maybeRunScheduledAmbientSummary } from "./scheduled-summary";
import { DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE } from "./summary-scheduler";
import type { AmbientTimelineStore } from "./types";

function store(): AmbientTimelineStore {
  const state = { current: DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE };
  return {
    kind: "memory",
    init: vi.fn(async () => { }),
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
    dismissTimelineEvent: vi.fn(async () => { }),
    markTimelineEventsSynced: vi.fn(async () => { }),
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

  test("persists provider metadata for cloud summaries", async () => {
    const timelineStore = store();
    vi.mocked(timelineStore.listRawEventsInRange).mockResolvedValue([
      raw("calendar_1", "calendar", "Meeting with product team"),
    ]);
    const bridge = {
      generateAmbientSummaryEvent: vi.fn(async () => ({
        ok: true as const,
        draft: {
          title: "Product meeting",
          summary: "You had a product discussion with the team.",
          tags: ["meeting"],
          confidence: 0.75,
          confidenceLabel: "certain" as const,
        },
        modelId: "gpt-5.5",
        generationMethod: "cloud_llm" as const,
        primarySourceLabel: "Ambient summary",
      })),
    };

    await maybeRunScheduledAmbientSummary({
      store: timelineStore,
      bridge,
      now: new Date("2026-05-19T11:15:00.000Z"),
      localDate: "2026-05-19",
      timezone: "UTC",
      localUserId: "local",
    });

    expect(timelineStore.upsertTimelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      generationMethod: "cloud_llm",
      primarySourceLabel: "Ambient summary",
      llmModelId: "gpt-5.5",
    }));
  });


  test("does not persist a Ambient summary when the privacy gate rejects it", async () => {
    const timelineStore = store();
    vi.mocked(timelineStore.listRawEventsInRange).mockResolvedValue([
      raw("calendar_2", "calendar", "Sensitive appointment"),
    ]);
    const bridge = {
      generateAmbientSummaryEvent: vi.fn(async () => ({
        ok: true as const,
        draft: {
          title: "Appointment",
          summary: "You had a sensitive appointment.",
          tags: ["calendar"],
          confidence: 0.7,
          confidenceLabel: "certain" as const,
        },
        modelId: "gpt-5.5",
        generationMethod: "cloud_llm" as const,
        primarySourceLabel: "Ambient summary",
      })),
    };

    const result = await maybeRunScheduledAmbientSummary({
      store: timelineStore,
      bridge,
      now: new Date("2026-05-19T12:15:00.000Z"),
      localDate: "2026-05-19",
      timezone: "UTC",
      localUserId: "local",
      shouldPersistResult: (summaryResult) => summaryResult.generationMethod !== "cloud_llm",
    });

    expect(result).toEqual({ ran: true, status: "failed" });
    expect(timelineStore.upsertTimelineEvent).not.toHaveBeenCalled();
    expect(timelineStore.setSummarySchedulerState).toHaveBeenCalledWith(expect.objectContaining({
      lastErrorCode: "cloud_result_discarded_after_lock",
    }));
  });

});

function raw(id: string, sourceType: "motion" | "location" | "calendar", compactText: string): import("./types").AmbientRawEvent {
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
