import { describe, expect, test } from "vitest";

import { buildAmbientSummaryContext } from "./summary-context";
import type { AmbientRawEvent, AmbientTimelineEvent } from "./types";

const baseRaw: Omit<AmbientRawEvent, "id" | "sourceType" | "eventType" | "compactText" | "occurredAt" | "dedupeKey"> = {
  localUserId: "local",
  deviceId: "phone",
  sourceVersion: "v1",
  collectedAt: "2026-05-19T10:00:00.000Z",
  timezone: "UTC",
  localDate: "2026-05-19",
  payload: {},
  confidence: null,
  sensitivity: "normal",
  permissionState: null,
  ttlExpiresAt: null,
  contentHash: "hash",
  processingStatus: "new",
  createdAt: "2026-05-19T10:00:00.000Z",
  updatedAt: "2026-05-19T10:00:00.000Z",
};

function raw(overrides: Partial<AmbientRawEvent>): AmbientRawEvent {
  return {
    ...baseRaw,
    id: overrides.id ?? "raw",
    sourceType: overrides.sourceType ?? "motion",
    eventType: overrides.eventType ?? "motion.activity",
    compactText: overrides.compactText ?? "Walking detected",
    occurredAt: overrides.occurredAt ?? "2026-05-19T10:00:00.000Z",
    dedupeKey: overrides.dedupeKey ?? overrides.id ?? "raw",
    ...overrides,
  };
}

function card(overrides: Partial<AmbientTimelineEvent>): AmbientTimelineEvent {
  const now = "2026-05-19T09:50:00.000Z";
  return {
    id: overrides.id ?? "event",
    localUserId: "local",
    localDate: "2026-05-19",
    timezone: "UTC",
    occurredAt: now,
    eventType: "other",
    title: "Previous summary",
    summary: "Earlier context",
    primarySourceLabel: "Ambient",
    deviceLabels: [],
    sourceTypes: ["motion"],
    tags: ["summary"],
    privacy: "normal",
    confidence: 0.7,
    confidenceLabel: "certain",
    salience: 0.6,
    rawRefs: [],
    observationIds: [],
    generationMethod: "local_llm",
    generationSource: "llm_summary",
    generationStatus: "visible",
    memoryCandidate: true,
    cardTriggerCandidate: false,
    schemaVersion: "ambient_timeline_event.v1",
    syncStatus: "pending",
    dedupeKey: overrides.id ?? "event",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("buildAmbientSummaryContext", () => {
  test("includes non-transcript raw events as summary material", () => {
    const context = buildAmbientSummaryContext({
      nowIso: "2026-05-19T10:15:00.000Z",
      localDate: "2026-05-19",
      rawEvents: [
        raw({ id: "motion_1", sourceType: "motion", compactText: "Walking for 12 minutes" }),
        raw({ id: "location_1", sourceType: "location", compactText: "Arrived at office" }),
        raw({ id: "transcript_1", sourceType: "transcript", compactText: "Discussed roadmap" }),
      ],
      recentSummaries: [card({ id: "summary_1" })],
    });

    expect(context.schemaVersion).toBe("ambient_summary.v1");
    expect(context.rawEvents.map((event) => event.sourceType)).toEqual(["motion", "location", "transcript"]);
    expect(context.rawEvents.map((event) => event.text)).toContain("Arrived at office");
    expect(context.recentSummaries[0]?.title).toBe("Previous summary");
  });

  test("passes diarized transcript text to the summary model with speaker labels", () => {
    const context = buildAmbientSummaryContext({
      nowIso: "2026-05-19T10:15:00.000Z",
      localDate: "2026-05-19",
      rawEvents: [
        raw({
          id: "transcript_1",
          sourceType: "transcript",
          compactText: "plain transcript fallback",
          payload: {
            text: "plain transcript fallback",
            speaker_segments: [
              { speaker: "self", text: "我觉得这个测试可行", start_ms: 0, end_ms: 1200 },
              { speaker: "speaker_1", text: "那我们明天继续", start_ms: 1300, end_ms: 2600 },
            ],
            speaker_labels: ["self", "speaker_1"],
            self_text: "我觉得这个测试可行",
          },
        }),
      ],
    });

    expect(context.rawEvents[0]?.text).toBe(
      'self: "我觉得这个测试可行"\nspeaker_1: "那我们明天继续"',
    );
  });
});
