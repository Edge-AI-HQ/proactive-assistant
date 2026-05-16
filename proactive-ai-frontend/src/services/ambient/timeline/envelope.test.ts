import { describe, expect, test } from "vitest";

import { locationUpdateWindowToSignal, timelineEventToSignal, visitWindowToSignal } from "./envelope";
import type { AmbientCandidateWindow, AmbientTimelineEvent } from "./types";

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


describe("location and visit evidence envelopes", () => {
  const locationWindow: AmbientCandidateWindow = {
    id: "win_location_1",
    localUserId: "local",
    localDate: "2026-05-15",
    windowType: "location_update",
    startedAt: "2026-05-15T14:05:00.000Z",
    timezone: "UTC",
    sourceTypes: ["location"],
    deviceLabels: ["iPhone"],
    rawRefs: [{ sourceType: "location", id: "raw_secret_location" }],
    observationIds: [],
    compactContext: "Location updated near Mission District around 2:05 PM.",
    privacyHint: "private",
    confidenceHint: 0.7,
    salienceHint: 0.35,
    generationPolicy: "do_not_generate",
    llmInputHash: null,
    status: "evidence",
    lastAttemptAt: null,
    attemptCount: 0,
    lastErrorCode: null,
    expiresAt: null,
    createdAt: "2026-05-15T14:05:00.000Z",
    updatedAt: "2026-05-15T14:05:00.000Z",
  };

  test("formats location_update with POI and coordinate context", () => {
    const signal = locationUpdateWindowToSignal(locationWindow, "place_changed");

    expect(signal.id).toBe("ambient-location-win_location_1");
    expect(signal.kind).toBe("ambient.location_update");
    expect(signal.title).toBe("Location update");
    expect(signal.summary).toBe("Location updated near Mission District around 2:05 PM.");
    expect(signal.dedupe_key).toBe("ambient:location_update:2026-05-15:win_location_1");
    expect(signal.payload).toEqual({
      schema_version: "ambient_location_update.v1",
      local_window_id: "win_location_1",
      window_type: "location_update",
      source_types: ["location"],
      privacy: "private",
      confidence: 0.7,
      salience: 0.35,
      local_date: "2026-05-15",
      started_at: "2026-05-15T14:05:00.000Z",
      raw_ref_count: 1,
      reason: "place_changed",
    });
    expect(signal.payload).not.toHaveProperty("raw_refs");
  });

  test("formats location_update with raw location metadata when provided", () => {
    const signal = locationUpdateWindowToSignal({
      ...locationWindow,
      metadata: {
        place: { label: "Mission District", place_name: "Mission Dolores" },
        latitude: 37.7599,
        longitude: -122.4148,
        accuracy: 25,
      },
    }, "place_changed");

    expect(signal.payload).toMatchObject({
      place: { label: "Mission District", place_name: "Mission Dolores" },
      latitude: 37.7599,
      longitude: -122.4148,
      accuracy: 25,
      reason: "place_changed",
    });
  });

  test("formats visit_event with POI context", () => {
    const signal = visitWindowToSignal({
      ...locationWindow,
      id: "win_visit_1",
      windowType: "visit_stay",
      sourceTypes: ["visit"],
      rawRefs: [{ sourceType: "visit", id: "raw_secret_visit" }],
      compactContext: "Visit signals indicate arrival near Ferry Building around 4:10 PM.",
      metadata: { place: { label: "Ferry Building", address: "1 Ferry Building" } },
    }, "arrival");

    expect(signal.id).toBe("ambient-visit-win_visit_1");
    expect(signal.kind).toBe("ambient.visit_event");
    expect(signal.payload).toMatchObject({
      schema_version: "ambient_visit_event.v1",
      local_window_id: "win_visit_1",
      window_type: "visit_stay",
      source_types: ["visit"],
      privacy: "private",
      visit_kind: "arrival",
      raw_ref_count: 1,
      place: { label: "Ferry Building", address: "1 Ferry Building" },
    });
    expect(signal.payload).not.toHaveProperty("raw_refs");
  });
});
