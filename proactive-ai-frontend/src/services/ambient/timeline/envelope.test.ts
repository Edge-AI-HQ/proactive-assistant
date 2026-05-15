import { describe, expect, test } from "vitest";

import { timelineEventToSignal } from "./envelope";
import type { AmbientTimelineEvent } from "./types";

const event: AmbientTimelineEvent = {
  id: "evt_1",
  localUserId: "local",
  localDate: "2026-05-15",
  timezone: "UTC",
  occurredAt: "2026-05-15T10:00:00.000Z",
  eventType: "conversation",
  title: "Call summary",
  summary: "Discussed follow-up items.",
  primarySourceLabel: "Microphone",
  deviceLabels: ["Microphone"],
  sourceTypes: ["transcript", "sound"],
  tags: ["conversation"],
  privacy: "private",
  confidence: 0.61,
  confidenceLabel: "uncertain",
  salience: 0.5,
  rawRefs: [{ sourceType: "transcript", id: "raw_secret" }],
  observationIds: [],
  windowId: "win_secret",
  generationMethod: "local_llm",
  generationStatus: "visible",
  memoryCandidate: true,
  cardTriggerCandidate: true,
  schemaVersion: "ambient_timeline_event.v1",
  syncStatus: "pending",
  dedupeKey: "ambient:timeline:2026-05-15:llm:stable",
  createdAt: "2026-05-15T10:00:00.000Z",
  updatedAt: "2026-05-15T10:00:00.000Z",
};

describe("timelineEventToSignal", () => {
  test("uploads only the approved ambient timeline payload fields", () => {
    const signal = timelineEventToSignal(event);

    expect(signal.payload).toEqual({
      event_type: "conversation",
      tags: ["conversation"],
      privacy: "private",
      confidence_label: "uncertain",
      source_types: ["transcript", "sound"],
      local_event_id: "evt_1",
      schema_version: "ambient_timeline_event.v1",
    });
    expect(JSON.stringify(signal)).not.toContain("raw_secret");
    expect(JSON.stringify(signal)).not.toContain("win_secret");
    expect(JSON.stringify(signal)).not.toContain("compactContext");
    expect(JSON.stringify(signal)).not.toContain("memoryCandidates");
    expect(JSON.stringify(signal)).not.toContain("actionCandidates");
  });
});
