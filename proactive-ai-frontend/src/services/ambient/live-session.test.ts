import { describe, expect, test, vi } from "vitest";

import {
  appendLiveTranscript,
  candidateWindowsToLiveSessionContextItems,
  liveSessionDataToSession,
  rawTranscriptEventsToHistory,
  rawTranscriptEventsToLiveSessionData,
  rawEventsToLiveSessionContextItems,
  type LiveSessionData,
} from "./live-session";
import {
  applyAmbientLiveTranscriptUpdate,
  applyCaptureSessionRotation,
  getAmbientLiveTranscriptSnapshot,
  getAmbientLiveTranscriptHistorySnapshot,
  resetAmbientLiveTranscriptForTest,
  showAmbientListening,
} from "./live-transcript-store";
import type { AmbientCandidateWindow, AmbientRawEvent } from "./timeline";


function makeTranscriptRaw(
  overrides: Partial<AmbientRawEvent> & Pick<AmbientRawEvent, "id" | "occurredAt" | "compactText">,
): AmbientRawEvent {
  return {
    id: overrides.id,
    localUserId: "local",
    deviceId: null,
    sourceType: "transcript",
    eventType: "transcript.ready",
    sourceVersion: "test",
    occurredAt: overrides.occurredAt,
    endedAt: overrides.endedAt,
    collectedAt: overrides.occurredAt,
    timezone: "Asia/Shanghai",
    localDate: "2026-05-17",
    payload: overrides.payload ?? { captureSessionId: "cap-db", provider: "cloud_whisper" },
    compactText: overrides.compactText,
    confidence: 0.75,
    sensitivity: "private",
    permissionState: null,
    ttlExpiresAt: null,
    contentHash: overrides.id,
    dedupeKey: `transcript:${overrides.id}`,
    processingStatus: "new",
    createdAt: overrides.occurredAt,
    updatedAt: overrides.occurredAt,
  };
}

function makeRaw(
  overrides: Partial<AmbientRawEvent> & Pick<AmbientRawEvent, "id" | "sourceType" | "eventType" | "occurredAt" | "compactText">,
): AmbientRawEvent {
  return {
    id: overrides.id,
    localUserId: "local",
    deviceId: null,
    sourceType: overrides.sourceType,
    eventType: overrides.eventType,
    sourceVersion: "test",
    occurredAt: overrides.occurredAt,
    endedAt: overrides.endedAt,
    collectedAt: overrides.occurredAt,
    timezone: "Asia/Shanghai",
    localDate: "2026-05-17",
    payload: overrides.payload ?? {},
    compactText: overrides.compactText,
    confidence: overrides.confidence ?? 0.75,
    sensitivity: overrides.sensitivity ?? "normal",
    permissionState: null,
    ttlExpiresAt: null,
    contentHash: overrides.id,
    dedupeKey: `${overrides.sourceType}:${overrides.id}`,
    processingStatus: "new",
    createdAt: overrides.occurredAt,
    updatedAt: overrides.occurredAt,
  };
}

function makeWindow(
  overrides: Partial<AmbientCandidateWindow> & Pick<AmbientCandidateWindow, "id" | "windowType" | "startedAt">,
): AmbientCandidateWindow {
  return {
    id: overrides.id,
    localUserId: "local",
    localDate: "2026-05-15",
    windowType: overrides.windowType,
    startedAt: overrides.startedAt,
    endedAt: overrides.endedAt,
    timezone: "Asia/Shanghai",
    sourceTypes: overrides.sourceTypes ?? ["location"],
    deviceLabels: overrides.deviceLabels ?? ["iPhone"],
    rawRefs: overrides.rawRefs ?? [{ sourceType: "location", id: "raw_secret" }],
    observationIds: [],
    compactContext: overrides.compactContext ?? "raw compact context with latitude 23.1 and /private/tmp/audio.wav",
    privacyHint: overrides.privacyHint ?? "private",
    confidenceHint: overrides.confidenceHint ?? 0.7,
    salienceHint: overrides.salienceHint ?? 0.5,
    generationPolicy: overrides.generationPolicy ?? "do_not_generate",
    llmInputHash: null,
    status: overrides.status ?? "evidence",
    lastAttemptAt: null,
    attemptCount: 0,
    lastErrorCode: null,
    expiresAt: null,
    createdAt: overrides.startedAt,
    updatedAt: overrides.startedAt,
  };
}

describe("candidate window live session context", () => {
  test("shows a fresh listening placeholder after an earlier transcript", () => {
    vi.setSystemTime(new Date("2026-05-17T05:01:30.000Z"));
    resetAmbientLiveTranscriptForTest();
    applyAmbientLiveTranscriptUpdate({
      captureSessionId: "cap-live",
      id: "burst-1",
      text: "第一段已经转出来了",
      source: "cloud_whisper",
      receivedAt: Date.parse("2026-05-17T05:00:00.000Z"),
    });

    showAmbientListening(Date.parse("2026-05-17T05:01:00.000Z"));

    expect(getAmbientLiveTranscriptSnapshot()?.messages).toEqual([
      expect.objectContaining({ id: "burst-1", text: "第一段已经转出来了" }),
      expect.objectContaining({ id: "listening", text: "Listening..." }),
    ]);
    resetAmbientLiveTranscriptForTest();
    vi.useRealTimers();
  });

  test("filters exact live transcript system error messages", () => {
    vi.setSystemTime(new Date("2026-05-17T10:01:30.000Z"));
    const unavailable = appendLiveTranscript(null, {
      captureSessionId: "cap-live",
      id: "burst-error",
      text: "Transcription unavailable",
      source: "cloud_whisper",
      receivedAt: Date.parse("2026-05-17T10:00:00.000Z"),
    });
    const realSpeech = appendLiveTranscript(unavailable, {
      captureSessionId: "cap-live",
      id: "burst-real",
      text: "There is an error in the dashboard",
      source: "cloud_whisper",
      receivedAt: Date.parse("2026-05-17T10:01:00.000Z"),
    });

    expect(unavailable.messages).toHaveLength(0);
    expect(realSpeech.messages).toEqual([
      expect.objectContaining({
        id: "burst-real",
        text: "There is an error in the dashboard",
      }),
    ]);
    vi.useRealTimers();
  });

  test("updates the same live burst from listening to draft to final text", () => {
    vi.setSystemTime(new Date("2026-05-17T10:00:00.000Z"));
    const listening = appendLiveTranscript(null, {
      captureSessionId: "ambient-live-listening",
      id: "listening",
      text: "Listening...",
      source: "microphone",
    });
    const draft = appendLiveTranscript(listening, {
      captureSessionId: "cap-live",
      id: "burst-1",
      text: "我现在正在说话",
      source: "draft",
    });
    const final = appendLiveTranscript(draft, {
      captureSessionId: "cap-live",
      id: "burst-1",
      text: "我现在正在说话，应该立刻显示",
      source: "local_speech",
    });

    expect(draft.messages).toHaveLength(1);
    expect(final.messages).toEqual([
      expect.objectContaining({
        id: "burst-1",
        text: "我现在正在说话，应该立刻显示",
        source: "local_speech",
      }),
    ]);
    vi.useRealTimers();
  });

  test("does not treat stale recovered transcript as current live", () => {
    vi.setSystemTime(new Date("2026-05-17T10:05:00.000Z"));

    const current = appendLiveTranscript(null, {
      captureSessionId: "cap-stale",
      id: "burst-stale",
      text: "五分钟前锁屏采集到的内容",
      source: "cloud_whisper",
      receivedAt: Date.parse("2026-05-17T10:00:00.000Z"),
    });

    expect(current.messages).toHaveLength(0);
    vi.useRealTimers();
  });

  test("keeps recent transcript update in current live", () => {
    vi.setSystemTime(new Date("2026-05-17T10:05:00.000Z"));

    const current = appendLiveTranscript(null, {
      captureSessionId: "cap-fresh",
      id: "burst-fresh",
      text: "刚刚说的内容应该显示在 Current Live",
      source: "cloud_whisper",
      receivedAt: Date.parse("2026-05-17T10:04:10.000Z"),
    });

    expect(current.messages).toEqual([
      expect.objectContaining({
        id: "burst-fresh",
        text: "刚刚说的内容应该显示在 Current Live",
      }),
    ]);
    vi.useRealTimers();
  });

  test("moves old current messages into history on capture session rotation", () => {
    vi.setSystemTime(new Date("2026-05-17T10:05:00.000Z"));
    resetAmbientLiveTranscriptForTest();
    applyAmbientLiveTranscriptUpdate({
      captureSessionId: "cap-old",
      id: "burst-old",
      text: "旧 session 的最后一句话",
      source: "cloud_whisper",
      receivedAt: Date.parse("2026-05-17T10:04:10.000Z"),
    });

    applyCaptureSessionRotation({
      oldCaptureSessionId: "cap-old",
      newCaptureSessionId: "cap-new",
      reason: "idle_gap",
      rotatedAt: "2026-05-17T10:05:00.000Z",
      idleGapMs: 30_000,
    });

    expect(getAmbientLiveTranscriptSnapshot()).toBeNull();
    expect(getAmbientLiveTranscriptHistorySnapshot()).toEqual([
      expect.objectContaining({
        id: "burst-old",
        captureSessionId: "cap-old",
        text: "旧 session 的最后一句话",
        source: "cloud_whisper",
      }),
    ]);
    resetAmbientLiveTranscriptForTest();
    vi.useRealTimers();
  });

  test("sorts windows by recency before limiting", () => {
    const windows = [
      makeWindow({ id: "old", windowType: "location_update", startedAt: "2026-05-15T10:00:00.000Z", compactContext: "Location updated near Old Place." }),
      makeWindow({ id: "new", windowType: "location_update", startedAt: "2026-05-15T10:04:00.000Z", compactContext: "Location updated near New Place." }),
      makeWindow({ id: "mid", windowType: "location_update", startedAt: "2026-05-15T10:02:00.000Z", compactContext: "Location updated near Mid Place." }),
    ];

    const items = candidateWindowsToLiveSessionContextItems(windows, {
      now: new Date("2026-05-15T10:05:00.000Z"),
      maxWindows: 2,
    });

    expect(items.map((item) => item.sourceWindowIds[0])).toEqual(["new", "mid"]);
    expect(items.map((item) => item.label)).toEqual(["Near New Place", "Near Mid Place"]);
  });

  test("filters ignored and low-confidence windows but allows pending transcript windows", () => {
    const items = candidateWindowsToLiveSessionContextItems([
      makeWindow({ id: "ignored", windowType: "location_update", startedAt: "2026-05-15T10:00:00.000Z", status: "ignored", compactContext: "Location updated near Hidden." }),
      makeWindow({ id: "weak", windowType: "sound_context", startedAt: "2026-05-15T10:01:00.000Z", sourceTypes: ["sound"], confidenceHint: 0.2, compactContext: "Heard speech for 10s." }),
      makeWindow({ id: "pending-transcript", windowType: "transcript_session", startedAt: "2026-05-15T10:02:00.000Z", sourceTypes: ["transcript"], status: "pending", compactContext: "Confidential transcript text about cap table" }),
    ], { now: new Date("2026-05-15T10:03:00.000Z") });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "live-window-pending-transcript",
      label: "Conversation window active",
      privacy: "private",
    });
  });

  test("does not expose raw refs coordinates or transcript compact context", () => {
    const items = candidateWindowsToLiveSessionContextItems([
      makeWindow({
        id: "transcript",
        windowType: "transcript_session",
        startedAt: "2026-05-15T10:00:00.000Z",
        sourceTypes: ["transcript"],
        status: "pending",
        compactContext: "Discussed secret investor terms near 23.1425,113.2401 /private/tmp/audio.wav raw_secret",
      }),
      makeWindow({
        id: "place",
        windowType: "location_update",
        startedAt: "2026-05-15T10:01:00.000Z",
        compactContext: "Location updated near WeWork.",
      }),
    ], { now: new Date("2026-05-15T10:02:00.000Z") });

    const serialized = JSON.stringify(items);
    expect(serialized).toContain("Conversation window active");
    expect(serialized).toContain("Near WeWork");
    expect(serialized).not.toContain("secret investor terms");
    expect(serialized).not.toContain("23.1425");
    expect(serialized).not.toContain("113.2401");
    expect(serialized).not.toContain("/private/tmp");
    expect(serialized).not.toContain("raw_secret");
  });

  test("merges transcript messages and context items into one live session", () => {
    vi.setSystemTime(new Date("2026-05-15T10:05:00.000Z"));
    const transcript: LiveSessionData = {
      captureSessionId: "cap-1",
      startedAt: Date.parse("2026-05-15T10:00:00.000Z"),
      messages: [{ id: "m1", time: "+00:30", text: "Discussing the launch plan", source: "local" }],
    };
    const contextItems = candidateWindowsToLiveSessionContextItems([
      makeWindow({ id: "place", windowType: "location_update", startedAt: "2026-05-15T10:01:00.000Z", compactContext: "Location updated near WeWork." }),
      makeWindow({ id: "motion", windowType: "motion_state_run", startedAt: "2026-05-15T10:02:00.000Z", sourceTypes: ["motion"], privacyHint: "normal", compactContext: "Motion stationary for 18m 0s." }),
    ], { now: new Date("2026-05-15T10:05:00.000Z") });

    const session = liveSessionDataToSession(true, transcript, contextItems);

    expect(session?.title).toBe("Discussing the launch plan");
    expect(session?.location).toBe("Near WeWork");
    expect(session?.signals).toEqual(expect.arrayContaining(["Near WeWork", "Stationary", "1 transcript"]));
    expect(session?.assists.map((item) => item.text)).toEqual(expect.arrayContaining([
      "Near WeWork · private",
      "Stationary",
      "Discussing the launch plan",
    ]));
    vi.useRealTimers();
  });

  test("hides transcript window placeholder when real transcript text is available", () => {
    const transcript: LiveSessionData = {
      captureSessionId: "cap-1",
      startedAt: Date.parse("2026-05-15T10:00:00.000Z"),
      messages: [{ id: "m1", time: "10:00", text: "这里面有什么？", source: "cloud_whisper" }],
    };
    const contextItems = candidateWindowsToLiveSessionContextItems([
      makeWindow({
        id: "pending-transcript",
        windowType: "transcript_session",
        startedAt: "2026-05-15T10:00:00.000Z",
        sourceTypes: ["transcript"],
        status: "pending",
        compactContext: "Transcript segment: stale placeholder should not render",
      }),
      makeWindow({
        id: "motion",
        windowType: "motion_state_run",
        startedAt: "2026-05-15T10:01:00.000Z",
        sourceTypes: ["motion"],
        privacyHint: "normal",
        compactContext: "Motion stationary for 18m 0s.",
      }),
    ], { now: new Date("2026-05-15T10:02:00.000Z") });

    const session = liveSessionDataToSession(true, transcript, contextItems);

    expect(session?.signals).toEqual(expect.arrayContaining(["Stationary", "1 transcript"]));
    expect(session?.signals).not.toContain("Conversation window active");
    expect(session?.assists.map((item) => item.text)).toEqual([
      "Stationary",
      "这里面有什么？",
    ]);
  });

  test("does not use transcript window text as current live replay when raw transcript events are not available", () => {
    const contextItems = candidateWindowsToLiveSessionContextItems([
      makeWindow({
        id: "pending-transcript",
        windowType: "transcript_session",
        startedAt: "2026-05-15T10:00:00.000Z",
        sourceTypes: ["transcript"],
        status: "pending",
        compactContext: "Transcript segment: 重启以后也应该显示之前的转录文字",
      }),
      makeWindow({
        id: "motion",
        windowType: "motion_state_run",
        startedAt: "2026-05-15T10:01:00.000Z",
        sourceTypes: ["motion"],
        privacyHint: "normal",
        compactContext: "Motion stationary for 18m 0s.",
      }),
    ], { now: new Date("2026-05-15T10:02:00.000Z") });

    const session = liveSessionDataToSession(true, null, contextItems);

    expect(session).toMatchObject({
      kind: "Ambient context",
      title: "Ambient context active",
      device: "iPhone",
    });
    expect(session?.signals).toEqual(["Stationary"]);
    expect(session?.signals).not.toContain("Conversation window active");
    expect(session?.assists.map((item) => item.text)).toEqual([
      "Stationary",
    ]);
  });

  test("adds latest raw device context to the live session in timestamp order", () => {
    const rawItems = rawEventsToLiveSessionContextItems([
      makeRaw({
        id: "old-health",
        sourceType: "health",
        eventType: "health.summary",
        occurredAt: "2026-05-17T05:00:00.000Z",
        compactText: "Health summary: 1200 steps today",
        sensitivity: "sensitive",
      }),
      makeRaw({
        id: "health",
        sourceType: "health",
        eventType: "health.summary",
        occurredAt: "2026-05-17T06:01:00.000Z",
        compactText: "Health summary: 1311 steps today",
        sensitivity: "sensitive",
      }),
      makeRaw({
        id: "location",
        sourceType: "location",
        eventType: "location.fix",
        occurredAt: "2026-05-17T06:00:00.000Z",
        compactText: "Location near Office.",
        sensitivity: "private",
      }),
      makeRaw({
        id: "motion",
        sourceType: "motion",
        eventType: "motion.segment",
        occurredAt: "2026-05-17T06:00:30.000Z",
        compactText: "Motion stationary for 1m 1s.",
      }),
      makeRaw({
        id: "sound",
        sourceType: "sound",
        eventType: "sound.scene_run",
        occurredAt: "2026-05-17T06:00:45.000Z",
        compactText: "Heard dictionary for 12s.",
      }),
    ], { now: new Date("2026-05-17T06:02:00.000Z") });

    const session = liveSessionDataToSession(true, null, rawItems);

    expect(session?.assists.map((item) => item.text)).toEqual([
      "Location near Office.",
      "Motion stationary for 1m 1s.",
      "Dictionary detected",
      "Health summary: 1311 steps today",
    ]);
    expect(session?.assists.every((item, index, items) =>
      index === 0 || (items[index - 1].sortTs ?? 0) <= (item.sortTs ?? 0),
    )).toBe(true);
  });



  test("keeps conservative display place labels from normalized location context", () => {
    const contextItems = candidateWindowsToLiveSessionContextItems([
      makeWindow({
        id: "location-display",
        windowType: "location_update",
        startedAt: "2026-05-15T10:01:00.000Z",
        compactContext: "Location: Near Driving School.",
        privacyHint: "private",
      }),
    ], { now: new Date("2026-05-15T10:05:00.000Z") });

    const session = liveSessionDataToSession(true, null, contextItems);

    expect(session).toMatchObject({
      title: "Sensing near Driving School",
      location: "Near Driving School",
    });
    expect(session?.assists[0].text).toBe("Near Driving School · private");
  });

  test("builds a context-only live session when transcript is absent", () => {
    const contextItems = candidateWindowsToLiveSessionContextItems([
      makeWindow({ id: "place", windowType: "location_update", startedAt: "2026-05-15T10:01:00.000Z", compactContext: "Location updated near WeWork." }),
      makeWindow({ id: "sound", windowType: "sound_context", startedAt: "2026-05-15T10:02:00.000Z", sourceTypes: ["sound"], privacyHint: "normal", compactContext: "Heard speech for 2m 0s, max confidence 72%." }),
    ], { now: new Date("2026-05-15T10:05:00.000Z") });

    const session = liveSessionDataToSession(true, null, contextItems);

    expect(session).toMatchObject({
      kind: "Ambient context",
      title: "Sensing near WeWork",
      location: "Near WeWork",
      device: "iPhone",
    });
    expect(session?.signals).toEqual(["Speech detected", "Near WeWork"]);
    expect(session?.assists).toHaveLength(2);
  });
});

describe("raw transcript live session replay", () => {
  test("keeps diarized speaker labels in transcript history", () => {
    const history = rawTranscriptEventsToHistory([
      makeTranscriptRaw({
        id: "speaker-aware",
        occurredAt: "2026-05-17T10:00:00.000Z",
        compactText: "plain transcript fallback",
        payload: {
          captureSessionId: "cap-speaker-aware",
          provider: "cloud_diarize",
          text: "plain transcript fallback",
          speaker_segments: [
            { speaker: "self", text: "我觉得这个测试可行", start_ms: 0, end_ms: 1200 },
            { speaker: "speaker_1", text: "那我们明天继续", start_ms: 1300, end_ms: 2600 },
          ],
          speaker_labels: ["self", "speaker_1"],
          self_text: "我觉得这个测试可行",
        },
      }),
    ]);

    expect(history).toEqual([
      expect.objectContaining({
        id: "speaker-aware",
        captureSessionId: "cap-speaker-aware",
        text: 'self: "我觉得这个测试可行"\nspeaker_1: "那我们明天继续"',
      }),
    ]);
  });

  test("replays persisted raw transcript events as today's live session snapshot", () => {
    vi.setSystemTime(new Date("2026-05-17T10:05:00.000Z"));
    const rawEvents = [
      makeTranscriptRaw({
        id: "old",
        occurredAt: "2026-05-17T09:00:00.000Z",
        compactText: "Transcript segment: previous session should not show",
        payload: { captureSessionId: "old-cap", provider: "local" },
      }),
      makeTranscriptRaw({
        id: "first",
        occurredAt: "2026-05-17T10:00:00.000Z",
        endedAt: "2026-05-17T10:00:20.000Z",
        compactText: "Transcript segment: first live transcript",
        payload: { captureSessionId: "cap-db", provider: "cloud_whisper" },
      }),
      makeTranscriptRaw({
        id: "second",
        occurredAt: "2026-05-17T10:01:00.000Z",
        endedAt: "2026-05-17T10:01:18.000Z",
        compactText: "Transcript segment: second live transcript",
        payload: { captureSessionId: "cap-db", provider: "cloud_whisper" },
      }),
    ];

    const replay = rawTranscriptEventsToLiveSessionData(rawEvents);
    const history = rawTranscriptEventsToHistory(rawEvents);

    expect(replay).toMatchObject({
      captureSessionId: "ambient-live-replay:2026-05-17",
      startedAt: Date.parse("2026-05-17T09:00:00.000Z"),
    });
    expect(replay?.messages.map((item) => item.text)).toEqual([
      "previous session should not show",
      "first live transcript",
      "second live transcript",
    ]);
    expect(history.map((item) => item.text)).toEqual([
      "second live transcript",
      "first live transcript",
      "previous session should not show",
    ]);
    vi.useRealTimers();
  });

  test("uses fresh raw transcript events in the same live snapshot", () => {
    vi.setSystemTime(new Date("2026-05-17T10:05:00.000Z"));

    const replay = rawTranscriptEventsToLiveSessionData([
      makeTranscriptRaw({
        id: "fresh",
        occurredAt: "2026-05-17T10:04:30.000Z",
        compactText: "Transcript segment: fresh live transcript",
        payload: { captureSessionId: "cap-fresh", provider: "cloud_whisper" },
      }),
    ]);

    expect(replay?.messages.map((item) => item.text)).toEqual([
      "fresh live transcript",
    ]);
    vi.useRealTimers();
  });
});
