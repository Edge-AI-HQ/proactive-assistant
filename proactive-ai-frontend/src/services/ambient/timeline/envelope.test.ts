import { describe, expect, test } from "vitest";

import { candidateWindowToSignal, timelineEventToSignal } from "./envelope";
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


const candidateWindow: AmbientCandidateWindow = {
  id: "win_transcript",
  localUserId: "local",
  localDate: "2026-05-15",
  windowType: "transcript_session",
  startedAt: "2026-05-15T10:00:00.000Z",
  endedAt: "2026-05-15T10:05:00.000Z",
  timezone: "UTC",
  sourceTypes: ["transcript", "location"],
  deviceLabels: ["Microphone", "iPhone"],
  rawRefs: [{ sourceType: "transcript", id: "raw_secret" }],
  observationIds: [],
  compactContext: "Transcript segment: near a known POI.",
  privacyHint: "private",
  confidenceHint: 0.7,
  salienceHint: 0.65,
  generationPolicy: "llm_allowed",
  llmInputHash: "hash_a",
  status: "pending",
  lastAttemptAt: null,
  attemptCount: 0,
  lastErrorCode: null,
  expiresAt: null,
  createdAt: "2026-05-15T10:00:00.000Z",
  updatedAt: "2026-05-15T10:01:00.000Z",
};

describe("candidateWindowToSignal", () => {
  test("uploads window metadata and selected source payloads with a stable envelope", () => {
    const signal = candidateWindowToSignal(candidateWindow, {
      sourcePayloads: [
        {
          source_type: "transcript",
          event_type: "transcript.ready",
          occurred_at: "2026-05-15T10:00:00.000Z",
          confidence: 0.75,
          relation: "window_raw_ref",
          payload: { text: "讨论上报方案", durationMs: 30000 },
        },
        {
          source_type: "location",
          event_type: "location.fix",
          occurred_at: "2026-05-15T09:59:00.000Z",
          relation: "nearby_context",
          payload: { latitude: 23.1, longitude: 113.2, place: { label: "POI" } },
        },
      ],
      contextHash: "ctx_hash",
    });

    expect(signal).toMatchObject({
      id: "ambient_candidate_window_win_transcript",
      kind: "ambient.candidate_window",
      title: "Ambient transcript_session window",
      summary: "near a known POI.",
      occurred_at: "2026-05-15T10:00:00.000Z",
      available_at: "2026-05-15T10:05:00.000Z",
      confidence: 0.7,
      salience: 0.65,
      dedupe_key: "ambient:candidate_window:2026-05-15:transcript_session:win_transcript",
    });
    expect(signal.payload).toEqual({
      schema_version: "ambient_candidate_window_upload.v1",
      local_window_id: "win_transcript",
      window_type: "transcript_session",
      source_types: ["transcript", "location"],
      privacy: "private",
      local_date: "2026-05-15",
      started_at: "2026-05-15T10:00:00.000Z",
      ended_at: "2026-05-15T10:05:00.000Z",
      timezone: "UTC",
      compact_context: "near a known POI.",
      content_hash: "ctx_hash",
      confidence_hint: 0.7,
      salience_hint: 0.65,
      generation_policy: "llm_allowed",
      window_status: "pending",
      raw_ref_count: 1,
      source_payloads: [
        {
          source_type: "transcript",
          event_type: "transcript.ready",
          occurred_at: "2026-05-15T10:00:00.000Z",
          confidence: 0.75,
          relation: "window_raw_ref",
          payload: { text: "讨论上报方案", durationMs: 30000 },
        },
        {
          source_type: "location",
          event_type: "location.fix",
          occurred_at: "2026-05-15T09:59:00.000Z",
          relation: "nearby_context",
          payload: { latitude: 23.1, longitude: 113.2, place: { label: "POI" } },
        },
      ],
    });
    expect(JSON.stringify(signal)).not.toContain("raw_secret");
  });

  test("uses a stable candidate-window identity independent of context hash", () => {
    const first = candidateWindowToSignal(candidateWindow, {
      sourcePayloads: [
        {
          source_type: "transcript",
          event_type: "transcript.ready",
          occurred_at: "2026-05-15T10:00:00.000Z",
          confidence: 0.75,
          relation: "window_raw_ref",
          payload: { text: "first context" },
        },
      ],
      contextHash: "ctx_first",
    });
    const second = candidateWindowToSignal(candidateWindow, {
      sourcePayloads: [
        {
          source_type: "transcript",
          event_type: "transcript.ready",
          occurred_at: "2026-05-15T10:00:00.000Z",
          confidence: 0.75,
          relation: "window_raw_ref",
          payload: { text: "second context" },
        },
      ],
      contextHash: "ctx_second",
    });

    expect(first.id).toBe("ambient_candidate_window_win_transcript");
    expect(second.id).toBe("ambient_candidate_window_win_transcript");
    expect(first.dedupe_key).toBe("ambient:candidate_window:2026-05-15:transcript_session:win_transcript");
    expect(second.dedupe_key).toBe("ambient:candidate_window:2026-05-15:transcript_session:win_transcript");
    expect(first.payload?.content_hash).toBe("ctx_first");
    expect(second.payload?.content_hash).toBe("ctx_second");
  });

});
