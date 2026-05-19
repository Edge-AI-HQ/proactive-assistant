import { describe, expect, test } from "vitest";

import type { PersonalSignalInput } from "@/lib/devices";
import { LocalAmbientTimelinePipeline } from "./pipeline";
import type { AmbientTimelineModelBridge } from "./models";
import { MemoryTimelineStore } from "./store";
import { AMBIENT_CANDIDATE_WINDOW_KIND, AMBIENT_TIMELINE_KIND } from "./types";

function makePipeline(): {
  store: MemoryTimelineStore;
  pipeline: LocalAmbientTimelinePipeline;
} {
  const store = new MemoryTimelineStore();
  return { store, pipeline: new LocalAmbientTimelinePipeline(store) };
}

describe("LocalAmbientTimelinePipeline", () => {
  test("turns health raw into a local visible timeline event signal", async () => {
    const { store, pipeline } = makePipeline();

    const signals = await pipeline.ingestSignal({
      kind: "health.observation",
      title: "Sleep session",
      summary: "420 min sleep session",
      occurred_at: "2026-05-15T07:20:00.000Z",
      payload: {
        metric: "sleep",
        local_date: "2026-05-15",
        observations: [{
          metric: "sleep",
          value: 420,
          unit: "minute",
        }],
      },
      dedupe_key: "health:sleep:1",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe(AMBIENT_TIMELINE_KIND);
    expect(signals[0]?.payload?.rawRefs).toBeUndefined();
    const events = await store.listTimelineEvents("2026-05-15", {
      visibleOnly: true,
    });
    expect(events[0]).toMatchObject({
      eventType: "morning",
      title: "Morning health",
      privacy: "sensitive",
      primarySourceLabel: "HealthKit",
    });
    expect(events[0]?.rawRefs).toHaveLength(1);
  });



  test("does not generate Morning health from zero-step-only raw", async () => {
    const { store, pipeline } = makePipeline();

    const signals = await pipeline.ingestSignal({
      kind: "health.observation",
      title: "Daily steps",
      summary: "0 steps today",
      occurred_at: "2026-05-15T08:00:00.000Z",
      payload: {
        metric: "steps",
        local_date: "2026-05-15",
        observations: [{ metric: "steps", value: 0, unit: "count" }],
      },
      dedupe_key: "health:steps:zero",
    });

    expect(signals).toEqual([]);
    expect(await store.listTimelineEvents("2026-05-15", { visibleOnly: true })).toEqual([]);
    expect(await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "morning_health",
    })).toEqual([]);
  });

  test("does not regenerate Morning health from historical zero-step raw", async () => {
    const { store, pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "health.observation",
      title: "Daily steps",
      summary: "0 steps today",
      occurred_at: "2026-05-15T08:00:00.000Z",
      payload: {
        metric: "steps",
        observations: [{ metric: "steps", value: 0, unit: "count" }],
      },
      dedupe_key: "health:steps:zero",
    });

    const signals = await pipeline.regenerateDay("2026-05-15");

    expect(signals).toEqual([]);
    expect(await store.listTimelineEvents("2026-05-15", { visibleOnly: true })).toEqual([]);
  });

  test("generates fact-based Morning health summary from valid observations", async () => {
    const { store, pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "health.observation",
      title: "Daily steps",
      summary: "8120 steps today",
      occurred_at: "2026-05-15T01:00:00.000Z",
      payload: {
        metric: "steps",
        observations: [{ metric: "steps", value: 8120, unit: "count" }],
      },
      dedupe_key: "health:steps:8120",
    });

    const [event] = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });

    expect(event?.summary).toContain("8120 steps today.");
    expect(event?.summary).not.toContain("summary is available");
  });

  test("does not generate Morning health from afternoon steps only", async () => {
    const { store, pipeline } = makePipeline();

    const signals = await pipeline.ingestSignal({
      kind: "health.observation",
      title: "Daily steps",
      summary: "8120 steps today",
      occurred_at: "2026-05-15T05:00:00.000Z",
      payload: {
        metric: "steps",
        observations: [{ metric: "steps", value: 8120, unit: "count" }],
      },
      dedupe_key: "health:steps:afternoon",
    });

    expect(signals).toEqual([]);
    expect(await store.listTimelineEvents("2026-05-15", { visibleOnly: true })).toEqual([]);
  });

  test("stores sound scene runs as evidence windows without visible events", async () => {
    const { store, pipeline } = makePipeline();

    const signals = await pipeline.ingestSignal({
      kind: "device.sound_scene_run",
      title: "music",
      summary: "Heard music",
      occurred_at: "2026-05-15T10:00:00.000Z",
      payload: {
        schema_version: "sound_scene_run.v1",
        label: "music",
        started_at: "2026-05-15T10:00:00.000Z",
        ended_at: "2026-05-15T10:01:10.000Z",
        durationMs: 70_000,
        sampleCount: 8,
        maxConfidence: 0.81,
      },
      confidence: 0.81,
      dedupe_key: "sound:music:2026-05-15T10:00:00.000Z",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe(AMBIENT_CANDIDATE_WINDOW_KIND);
    expect(signals[0]?.payload).toMatchObject({
      window_type: "sound_context",
      source_payloads: [expect.objectContaining({
        source_type: "sound",
        payload: expect.objectContaining({ label: "music" }),
      })],
    });
    expect(await store.listTimelineEvents("2026-05-15", { visibleOnly: true })).toEqual([]);
    const [window] = await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "sound_context",
    });
    expect(window).toMatchObject({
      generationPolicy: "do_not_generate",
      status: "evidence",
      sourceTypes: ["sound"],
    });
    expect(window?.compactContext).toBe("Heard music for 1m 10s, max confidence 81%.");
  });

  test("stores motion segments as evidence windows without visible events", async () => {
    const { store, pipeline } = makePipeline();

    const signals = await pipeline.ingestSignal({
      kind: "device.motion_segment",
      title: "Motion: walking",
      summary: "walking",
      occurred_at: "2026-05-15T08:00:00.000Z",
      payload: {
        schema_version: "motion_segment.v1",
        activity: "walking",
        started_at: "2026-05-15T08:00:00.000Z",
        ended_at: "2026-05-15T08:02:00.000Z",
        durationMs: 120_000,
        sampleCount: 3,
        maxConfidence: "high",
        lastConfidence: "medium",
      },
      dedupe_key: "motion:walking:2026-05-15T08:00:00.000Z",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe(AMBIENT_CANDIDATE_WINDOW_KIND);
    expect(signals[0]?.payload).toMatchObject({
      window_type: "motion_state_run",
      source_payloads: [expect.objectContaining({
        source_type: "motion",
        payload: expect.objectContaining({ activity: "walking" }),
      })],
    });
    const [window] = await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "motion_state_run",
    });
    expect(window).toMatchObject({
      generationPolicy: "do_not_generate",
      status: "evidence",
      sourceTypes: ["motion"],
    });
    expect(window?.compactContext).toBe("Motion walking for 2m 0s.");
  });

  test("uses overlapping motion segments as transition evidence", async () => {
    const { store, pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "device.visit",
      title: "Departed Office",
      summary: "Departed Office",
      occurred_at: "2026-05-15T08:05:00.000Z",
      payload: { kind: "departure", place: { label: "Office" } },
      dedupe_key: "visit:office:departure",
    });
    await pipeline.ingestSignal({
      kind: "device.motion_segment",
      title: "Motion: automotive",
      summary: "automotive",
      occurred_at: "2026-05-15T07:55:00.000Z",
      payload: {
        schema_version: "motion_segment.v1",
        activity: "automotive",
        started_at: "2026-05-15T07:55:00.000Z",
        ended_at: "2026-05-15T08:20:00.000Z",
        durationMs: 1_500_000,
        sampleCount: 4,
        maxConfidence: "high",
      },
      dedupe_key: "motion:automotive:2026-05-15T07:55:00.000Z",
    });
    await pipeline.ingestSignal({
      kind: "device.visit",
      title: "Arrived Gym",
      summary: "Arrived Gym",
      occurred_at: "2026-05-15T08:24:00.000Z",
      payload: { kind: "arrival", place: { label: "Gym" } },
      dedupe_key: "visit:gym:arrival",
    });

    const [transition] = (await store.listTimelineEvents("2026-05-15", { visibleOnly: true }))
      .filter((event) => event.eventType === "transition");

    expect(transition?.sourceTypes).toContain("motion");
    expect(transition?.summary).toContain("Motion signals matched the transition");
  });





  test("uploads accepted location updates with POI payload subset", async () => {
    const { store, pipeline } = makePipeline();

    const first = await pipeline.ingestSignal({
      kind: "device.location",
      title: "Location",
      summary: "Near Office",
      occurred_at: "2026-05-15T09:00:00.000Z",
      payload: {
        latitude: 31.2,
        longitude: 121.5,
        accuracy: 18,
        place: {
          label: "Office",
          place_name: "PIN Office",
          address: "100 Century Ave, Shanghai",
          poi_name: "PIN HQ",
          poi_category: "office",
          poi_distance_m: 12.5,
          areas_of_interest: ["Lujiazui", "Tower A"],
          locality: "Shanghai",
          country: "China",
          country_code: "CN",
          resolved_at: 1_779_000_000_000,
          raw_debug: { provider: "internal" },
        },
        heading: 90,
        speed: 1.2,
        localFilePath: "/private/tmp/location.json",
      },
      dedupe_key: "location:office:1",
    });
    const duplicate = await pipeline.ingestSignal({
      kind: "device.location",
      title: "Location",
      summary: "Still Office",
      occurred_at: "2026-05-15T09:02:00.000Z",
      payload: { latitude: 31.20001, longitude: 121.50001, accuracy: 20, place: { label: "Office" } },
      dedupe_key: "location:office:2",
    });
    const nextPlace = await pipeline.ingestSignal({
      kind: "device.location",
      title: "Location",
      summary: "Near Gym",
      occurred_at: "2026-05-15T10:20:00.000Z",
      payload: { latitude: 31.25, longitude: 121.55, accuracy: 16, place: { label: "Gym" } },
      dedupe_key: "location:gym:1",
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe(AMBIENT_CANDIDATE_WINDOW_KIND);
    expect(first[0]?.payload).toMatchObject({
      window_type: "location_update",
      source_payloads: [expect.objectContaining({
        source_type: "location",
        payload: expect.objectContaining({
          latitude: 31.2,
          longitude: 121.5,
          accuracy: 18,
          place: expect.objectContaining({ label: "Office" }),
          poi: {
            label: "Office",
            place_name: "PIN Office",
            address: "100 Century Ave, Shanghai",
            poi_name: "PIN HQ",
            poi_category: "office",
            poi_distance_m: 12.5,
            areas_of_interest: ["Lujiazui", "Tower A"],
            locality: "Shanghai",
            country: "China",
            country_code: "CN",
          },
        }),
      })],
    });
    expect(JSON.stringify(first[0]?.payload)).not.toContain("localFilePath");
    expect(JSON.stringify(first[0]?.payload)).not.toContain("heading");
    expect(JSON.stringify(first[0]?.payload)).not.toContain("speed");
    expect(JSON.stringify(first[0]?.payload)).not.toContain("raw_debug");
    expect(JSON.stringify(first[0]?.payload)).not.toContain("resolved_at");
    expect(duplicate).toEqual([]);
    expect(nextPlace.map((signal) => signal.payload?.window_type)).toEqual(["location_update"]);
    expect(await store.listTimelineEvents("2026-05-15", { visibleOnly: true })).toEqual([]);
  });

  test("uploads visit and transition candidate windows with source payload subsets", async () => {
    const { pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "device.visit",
      title: "Departed Office",
      summary: "Departed Office",
      occurred_at: "2026-05-15T08:05:00.000Z",
      payload: {
        kind: "departure",
        place: {
          label: "Office",
          place_name: "PIN Office",
          address: "100 Century Ave, Shanghai",
          locality: "Shanghai",
          source: "mapkit+clgeocoder",
        },
        latitude: 31.2,
        longitude: 121.5,
      },
      dedupe_key: "visit:office:departure:upload",
    });
    await pipeline.ingestSignal({
      kind: "device.motion_segment",
      title: "Motion: automotive",
      summary: "automotive",
      occurred_at: "2026-05-15T08:06:00.000Z",
      payload: {
        schema_version: "motion_segment.v1",
        activity: "automotive",
        started_at: "2026-05-15T08:06:00.000Z",
        ended_at: "2026-05-15T08:20:00.000Z",
        durationMs: 840_000,
        localFilePath: "/private/tmp/motion.json",
      },
      dedupe_key: "motion:auto:transition:upload",
    });
    const signals = await pipeline.ingestSignal({
      kind: "device.visit",
      title: "Arrived Gym",
      summary: "Arrived Gym",
      occurred_at: "2026-05-15T08:24:00.000Z",
      payload: {
        kind: "arrival",
        place: {
          label: "Gym",
          place_name: "Fitness Center",
          poi_category: "fitnessCenter",
          administrative_area: "Shanghai",
          unexpected_blob: { debug: true },
        },
        latitude: 31.25,
        longitude: 121.55,
      },
      dedupe_key: "visit:gym:arrival:upload",
    });

    const candidateSignals = signals.filter((signal) => signal.kind === AMBIENT_CANDIDATE_WINDOW_KIND);
    expect(candidateSignals.map((signal) => signal.payload?.window_type)).toEqual([
      "visit_stay",
      "transition",
    ]);
    const visitStay = candidateSignals.find((signal) => signal.payload?.window_type === "visit_stay");
    expect(visitStay?.payload?.source_payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_type: "visit",
        payload: expect.objectContaining({
          kind: "arrival",
          poi: expect.objectContaining({
            label: "Gym",
            place_name: "Fitness Center",
            poi_category: "fitnessCenter",
            administrative_area: "Shanghai",
          }),
        }),
      }),
    ]));
    const transition = candidateSignals.find((signal) => signal.payload?.window_type === "transition");
    expect(transition?.payload?.source_payloads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_type: "visit",
        payload: expect.objectContaining({
          kind: "departure",
          poi: expect.objectContaining({ label: "Office", place_name: "PIN Office" }),
        }),
      }),
      expect.objectContaining({
        source_type: "motion",
        payload: expect.not.objectContaining({ poi: expect.anything() }),
      }),
      expect.objectContaining({
        source_type: "visit",
        payload: expect.objectContaining({
          kind: "arrival",
          poi: expect.objectContaining({ label: "Gym", place_name: "Fitness Center" }),
        }),
      }),
    ]));
    expect(JSON.stringify(transition?.payload)).not.toContain("localFilePath");
    expect(JSON.stringify(transition?.payload)).not.toContain("unexpected_blob");
  });

  test("keeps transcript sessions as pending windows in milestone A", async () => {
    const { store, pipeline } = makePipeline();

    const signal = {
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed a product review and a follow-up item.",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: {
        captureSessionId: "cap-1",
        durationMs: 180_000,
      },
      dedupe_key: "audio:burst:1",
    } as const;

    const signals = await pipeline.ingestSignal(signal);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe(AMBIENT_CANDIDATE_WINDOW_KIND);
    await pipeline.ingestSignal(signal);
    expect(await store.listTimelineEvents("2026-05-15", {
      visibleOnly: true,
    })).toEqual([]);
    const windows = await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "transcript_session",
    });
    expect(windows[0]).toMatchObject({
      generationPolicy: "llm_allowed",
      status: "pending",
      privacyHint: "private",
    });
    expect(windows[0]?.compactContext.match(/Discussed a product review/g)).toHaveLength(1);
  });

  test("keeps one growing transcript window for multiple raw segments in a session", async () => {
    const { store, pipeline } = makePipeline();
    const signals: PersonalSignalInput[] = [];

    for (let i = 0; i < 5; i += 1) {
      signals.push(...await pipeline.ingestSignal({
        kind: "session_summary",
        title: "Voice summary",
        summary: `Segment ${i + 1} from the same live transcript session.`,
        occurred_at: `2026-05-15T10:0${i}:00.000Z`,
        payload: {
          captureSessionId: "cap-growing",
          burstId: `burst-${i + 1}`,
          durationMs: 30_000,
        },
        dedupe_key: `audio:burst:growing:${i + 1}`,
      }));
    }

    const raws = await store.listRawEvents({
      localDate: "2026-05-15",
      sourceType: "transcript",
    });
    const windows = await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "transcript_session",
    });
    const latestSignal = signals[signals.length - 1];

    expect(raws).toHaveLength(5);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.rawRefs).toHaveLength(5);
    expect(windows[0]?.compactContext).toContain("Segment 1");
    expect(windows[0]?.compactContext).toContain("Segment 5");
    expect(latestSignal?.payload?.raw_ref_count).toBe(5);
    expect(latestSignal?.dedupe_key).toBe(
      `ambient:candidate_window:2026-05-15:transcript_session:${windows[0]?.id}`,
    );
  });


  test("uses batch decisions to create LLM summary events and mark windows summarized", async () => {
    const store = new MemoryTimelineStore();
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineBatchDecision(input) {
        return { ok: true, batch: { decisions: [{
          action: "create",
          title: "Product review",
          summary: "Discussed product review follow-ups.",
          importance: "medium",
          occurredAt: input.windows[0]?.startedAt ?? "2026-05-15T10:00:00.000Z",
          sourceWindowIds: [input.windows[0]?.id ?? ""],
        }] } };
      },
      async generateTimelineEvent() { throw new Error("single-window path should not run"); },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge);

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed a product review and a follow-up item that needs to be sent after the meeting with enough detail for local summarization.",
      occurred_at: "2026-05-15T10:00:00.000Z",
      payload: { captureSessionId: "cap-batch", durationMs: 180_000 },
      dedupe_key: "audio:burst:batch:1",
    });

    const signals = await pipeline.processPendingWindows("2026-05-15");

    expect(signals).toHaveLength(1);
    const [event] = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });
    expect(event).toMatchObject({
      generationMethod: "local_llm",
      generationSource: "llm_summary",
      title: "Product review",
      sourceWindowIds: expect.any(Array),
    });
    const [window] = await store.listCandidateWindows({ localDate: "2026-05-15", windowType: "transcript_session" });
    expect(window?.summaryStatus).toBe("summarized");
  });


  test("records native generation error messages on failed summary attempts", async () => {
    const store = new MemoryTimelineStore();
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineBatchDecision() {
        return {
          ok: false,
          errorCode: "generation_failed",
          errorMessage: "llama_init_from_model returned nil.",
        };
      },
      async generateTimelineEvent() { throw new Error("single-window path should not run"); },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge);

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "A detailed transcript window that should attempt local LLM generation and preserve the native error detail when it fails.",
      occurred_at: "2026-05-15T13:00:00.000Z",
      payload: { captureSessionId: "cap-error", durationMs: 180_000 },
      dedupe_key: "audio:burst:error:1",
    });
    await pipeline.processPendingWindows("2026-05-15");

    const [window] = await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "transcript_session",
    });
    expect(window).toMatchObject({
      lastErrorCode: "generation_failed",
      summaryErrorCode: "generation_failed",
      summaryErrorMessage: "llama_init_from_model returned nil.",
    });
  });


  test("force processes ready windows even when retry backoff is active", async () => {
    const store = new MemoryTimelineStore();
    let calls = 0;
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineBatchDecision(input) {
        calls += 1;
        return { ok: true, batch: { decisions: [{
          action: "skip",
          reason: "manual retry probe",
          sourceWindowIds: [input.windows[0]?.id ?? ""],
        }] } };
      },
      async generateTimelineEvent() { throw new Error("single-window path should not run"); },
    };
    const now = new Date("2026-05-15T13:05:00.000Z");
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge, { now: () => now });

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "A ready transcript window that previously failed and should be manually retried before its backoff expires.",
      occurred_at: "2026-05-15T13:00:00.000Z",
      payload: { captureSessionId: "cap-force", durationMs: 180_000 },
      dedupe_key: "audio:burst:force:1",
    });
    const [window] = await store.listCandidateWindows({ localDate: "2026-05-15", windowType: "transcript_session" });
    if (!window) throw new Error("expected candidate window");
    await store.upsertCandidateWindow({
      ...window,
      lastAttemptAt: "2026-05-15T13:04:30.000Z",
      attemptCount: 3,
      lastErrorCode: "generation_failed",
    });

    expect(await pipeline.processPendingWindows("2026-05-15")).toEqual([]);
    expect(calls).toBe(0);

    await pipeline.processPendingWindows("2026-05-15", { force: true });
    expect(calls).toBe(1);
  });


  test("manual refresh can process recent pending windows from yesterday after local midnight", async () => {
    const store = new MemoryTimelineStore();
    let processedWindowDate: string | null = null;
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineBatchDecision(input) {
        processedWindowDate = input.windows[0]?.localDate ?? null;
        return { ok: true, batch: { decisions: [{
          action: "skip",
          reason: "manual retry across midnight",
          sourceWindowIds: [input.windows[0]?.id ?? ""],
        }] } };
      },
      async generateTimelineEvent() { throw new Error("single-window path should not run"); },
    };
    const now = new Date("2026-05-18T00:05:00.000+08:00");
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge, { now: () => now });

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "A detailed transcript window recorded before midnight should still be eligible when the user manually taps Summary now after midnight.",
      occurred_at: "2026-05-17T15:55:00.000Z",
      payload: { captureSessionId: "cap-midnight", durationMs: 180_000 },
      dedupe_key: "audio:burst:midnight:1",
    });

    expect(await pipeline.processPendingWindows("2026-05-18", { force: true })).toEqual([]);
    await pipeline.processPendingWindows("2026-05-18", { force: true, includeRecentPending: true });

    expect(processedWindowDate).toBe("2026-05-17");
  });


  test("manual forceReady bypasses readiness guards for explicit test runs", async () => {
    const store = new MemoryTimelineStore();
    let calls = 0;
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineBatchDecision(input) {
        calls += 1;
        return { ok: true, batch: { decisions: [{
          action: "skip",
          reason: "manual readiness bypass",
          sourceWindowIds: [input.windows[0]?.id ?? ""],
        }] } };
      },
      async generateTimelineEvent() { throw new Error("single-window path should not run"); },
    };
    const now = new Date("2026-05-15T13:00:20.000Z");
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge, { now: () => now });

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "A fresh transcript window that is long enough for LLM input but not yet old enough for the normal readiness guard.",
      occurred_at: "2026-05-15T13:00:00.000Z",
      payload: { captureSessionId: "cap-force-ready", durationMs: 180_000 },
      dedupe_key: "audio:burst:force-ready:1",
    });

    await pipeline.processPendingWindows("2026-05-15", { force: true });
    expect(calls).toBe(0);

    await pipeline.processPendingWindows("2026-05-15", { force: true, forceReady: true });
    expect(calls).toBe(1);
  });


  test("persists LLM summary metadata when using SQLite-like store semantics", async () => {
    const store = new MemoryTimelineStore();
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineBatchDecision(input) {
        return { ok: true, batch: { decisions: [{
          action: "create",
          title: "Metadata summary",
          summary: "Persisted metadata should survive store upsert.",
          importance: "medium",
          occurredAt: input.windows[0]?.startedAt ?? "2026-05-15T10:00:00.000Z",
          sourceWindowIds: [input.windows[0]?.id ?? ""],
        }] } };
      },
      async generateTimelineEvent() { throw new Error("single-window path should not run"); },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge);

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "A long enough transcript window for checking summary metadata persistence on the generated local card.",
      occurred_at: "2026-05-15T12:00:00.000Z",
      payload: { captureSessionId: "cap-metadata", durationMs: 180_000 },
      dedupe_key: "audio:burst:metadata:1",
    });
    await pipeline.processPendingWindows("2026-05-15");

    const llmEvents = await store.listTimelineEventsByGenerationSource("2026-05-15", "llm_summary", { visibleOnly: true });
    expect(llmEvents[0]).toMatchObject({
      generationSource: "llm_summary",
      idempotencyKey: expect.stringContaining("summary:create:"),
      sourceWindowIds: expect.arrayContaining([expect.stringContaining("win_")]),
    });
  });

  test("persists actionCandidates from a batch create decision onto the timeline event", async () => {
    const store = new MemoryTimelineStore();
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineBatchDecision(input) {
        return { ok: true, batch: { decisions: [{
          action: "create",
          title: "Sequoia bridge call",
          summary: "Discussed the Series A bridge call with Mike from Sequoia.",
          importance: "high",
          occurredAt: input.windows[0]?.startedAt ?? "2026-05-15T10:00:00.000Z",
          sourceWindowIds: [input.windows[0]?.id ?? ""],
          actionCandidates: [{
            label: "Send recap to Mike",
            goal: "Draft a follow-up email to Mike recapping the Sequoia bridge call and attach the updated cap table.",
            goalBasket: "work",
          }],
        }] } };
      },
      async generateTimelineEvent() { throw new Error("single-window path should not run"); },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge);

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "A long enough transcript of the Sequoia bridge call between Mike and the founder discussing the Series A follow-up actions.",
      occurred_at: "2026-05-15T12:00:00.000Z",
      payload: { captureSessionId: "cap-action", durationMs: 180_000 },
      dedupe_key: "audio:burst:action:1",
    });
    await pipeline.processPendingWindows("2026-05-15");

    const [event] = await store.listTimelineEventsByGenerationSource("2026-05-15", "llm_summary", { visibleOnly: true });
    expect(event?.actionCandidates).toEqual([{
      label: "Send recap to Mike",
      goal: "Draft a follow-up email to Mike recapping the Sequoia bridge call and attach the updated cap table.",
      goalBasket: "work",
    }]);
  });

  test("omits actionCandidates when the batch create decision has none", async () => {
    const store = new MemoryTimelineStore();
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineBatchDecision(input) {
        return { ok: true, batch: { decisions: [{
          action: "create",
          title: "Quiet check-in",
          summary: "Brief casual exchange with no clear next step.",
          importance: "low",
          occurredAt: input.windows[0]?.startedAt ?? "2026-05-15T10:00:00.000Z",
          sourceWindowIds: [input.windows[0]?.id ?? ""],
        }] } };
      },
      async generateTimelineEvent() { throw new Error("single-window path should not run"); },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge);

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "A long enough transcript of a brief check-in with no clear next step for the user to act on.",
      occurred_at: "2026-05-15T12:00:00.000Z",
      payload: { captureSessionId: "cap-noaction", durationMs: 180_000 },
      dedupe_key: "audio:burst:noaction:1",
    });
    await pipeline.processPendingWindows("2026-05-15");

    const [event] = await store.listTimelineEventsByGenerationSource("2026-05-15", "llm_summary", { visibleOnly: true });
    expect(event?.actionCandidates).toBeUndefined();
  });

  test("does not revive a dismissed event on the same dedupe key", async () => {
    const { store, pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "health.observation",
      title: "Daily steps",
      summary: "1000 steps today",
      occurred_at: "2026-05-15T01:00:00.000Z",
      payload: { metric: "steps", observations: [{ metric: "steps", value: 1000 }] },
      dedupe_key: "health:steps:1",
    });
    const [event] = await store.listTimelineEvents("2026-05-15", {
      visibleOnly: true,
    });
    expect(event).toBeDefined();
    if (!event) throw new Error("expected generated event");
    await store.dismissTimelineEvent(event.id, "2026-05-15T08:01:00.000Z");

    const signals = await pipeline.ingestSignal({
      kind: "health.observation",
      title: "Daily steps",
      summary: "1200 steps today",
      occurred_at: "2026-05-15T01:05:00.000Z",
      payload: { metric: "steps", observations: [{ metric: "steps", value: 1200 }] },
      dedupe_key: "health:steps:2",
    });

    expect(signals).toEqual([]);
    expect(await store.listTimelineEvents("2026-05-15", {
      visibleOnly: true,
    })).toEqual([]);
  });

  test("generates one stable local LLM event per transcript window", async () => {
    const store = new MemoryTimelineStore();
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() {
        return null;
      },
      async generateTimelineEvent() {
        return { ok: true, draft: {
          eventType: "conversation",
          title: "Product review",
          summary: "Discussed a product review and a follow-up item.",
          tags: ["conversation", "work"],
          confidence: 0.7,
          confidenceLabel: "certain",
          salientFacts: ["Follow-up item discussed"],
        } };
      },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge);

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed a product review and a follow-up item that needs to be sent after the meeting with enough detail for local summarization.",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: {
        captureSessionId: "cap-stable",
        durationMs: 180_000,
      },
      dedupe_key: "audio:burst:stable:1",
    });

    const firstSignals = await pipeline.processPendingWindows("2026-05-15");
    expect(firstSignals).toHaveLength(1);
    const [firstEvent] = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });
    expect(firstEvent).toMatchObject({
      eventType: "conversation",
      generationMethod: "local_llm",
      title: "Product review",
      dedupeKey: expect.stringContaining("ambient:timeline:2026-05-15:llm:"),
    });
    expect(firstEvent?.dedupeKey).not.toContain(firstEvent?.summary ?? "");

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Also mentioned sending the updated cap table by Friday after the product review with enough detail for local summarization.",
      occurred_at: "2026-05-15T10:05:00.000Z",
      payload: {
        captureSessionId: "cap-stable",
        durationMs: 60_000,
      },
      dedupe_key: "audio:burst:stable:2",
    });

    await pipeline.processPendingWindows("2026-05-15");
    const events = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(firstEvent?.id);
    expect(events[0]?.dedupeKey).toBe(firstEvent?.dedupeKey);
  });

  test("does not revive dismissed local LLM transcript events", async () => {
    const store = new MemoryTimelineStore();
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineEvent() {
        return { ok: true, draft: {
          eventType: "conversation",
          title: "Dismissed conversation",
          summary: "Discussed a topic that should stay hidden after dismiss.",
          tags: ["conversation"],
          confidence: 0.72,
          confidenceLabel: "certain",
          salientFacts: [],
        } };
      },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge);

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed a topic that should stay hidden after dismiss and has enough text for local summarization to pass the ready gate.",
      occurred_at: "2026-05-15T11:00:00.000Z",
      payload: { captureSessionId: "cap-dismiss", durationMs: 120_000 },
      dedupe_key: "audio:burst:dismiss:1",
    });
    await pipeline.processPendingWindows("2026-05-15");
    const [event] = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });
    expect(event).toBeDefined();
    if (!event) throw new Error("expected generated event");
    await store.dismissTimelineEvent(event.id, "2026-05-15T11:10:00.000Z");

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Added more transcript text after dismiss, but stable event identity must stay hidden and never produce a visible card again.",
      occurred_at: "2026-05-15T11:05:00.000Z",
      payload: { captureSessionId: "cap-dismiss", durationMs: 60_000 },
      dedupe_key: "audio:burst:dismiss:2",
    });
    const signals = await pipeline.processPendingWindows("2026-05-15");

    expect(signals).toEqual([]);
    expect(await store.listTimelineEvents("2026-05-15", { visibleOnly: true })).toEqual([]);
  });


  test("does not call local LLM before transcript window is ready", async () => {
    const store = new MemoryTimelineStore();
    let calls = 0;
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineEvent() {
        calls += 1;
        return { ok: true, draft: {
          eventType: "conversation",
          title: "Too early",
          summary: "This should not be generated before the idle cutoff.",
          tags: ["conversation"],
          confidence: 0.7,
          confidenceLabel: "certain",
          salientFacts: [],
        } };
      },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge, {
      now: () => new Date("2026-05-15T10:03:30.000Z"),
    });

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed a product review and a follow-up item that needs to be sent after the meeting with enough detail for local summarization.",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: { captureSessionId: "cap-ready", durationMs: 180_000 },
      dedupe_key: "audio:burst:ready:1",
    });

    expect(await pipeline.processPendingWindows("2026-05-15")).toEqual([]);
    expect(calls).toBe(0);
  });


  test("uploads transcript window with transcript and nearby location source payloads", async () => {
    const { pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "device.location",
      title: "Location",
      summary: "Location at 23.1425,113.2401 /private/tmp/local.caf",
      occurred_at: "2026-05-15T09:59:00.000Z",
      payload: {
        latitude: 23.1425,
        longitude: 113.2401,
        accuracy: 9.7,
        speed: 0,
        heading: 90,
        localFilePath: "/private/tmp/should-not-upload.caf",
        place: { label: "出发点(大兴街店)", address: "Pengcheng East Road" },
      },
      dedupe_key: "location:near-transcript",
    });

    const signals = await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "我们需要把 window 表里的数据上报给云端 LLM 生成 Intent Cards。",
      occurred_at: "2026-05-15T10:00:00.000Z",
      payload: {
        captureSessionId: "cap-upload",
        burstId: "burst-upload",
        durationMs: 60_000,
        provider: "local_speech",
        localFilePath: "/private/tmp/audio.wav",
      },
      confidence: 0.75,
      dedupe_key: "audio:burst:upload:1",
    });

    const candidate = signals.find((signal) => signal.kind === AMBIENT_CANDIDATE_WINDOW_KIND);
    expect(candidate).toBeDefined();
    expect(candidate?.payload?.source_payloads).toEqual([
      expect.objectContaining({
        source_type: "transcript",
        event_type: "transcript.ready",
        relation: "window_raw_ref",
        payload: expect.objectContaining({
          text: "我们需要把 window 表里的数据上报给云端 LLM 生成 Intent Cards。",
          durationMs: 60000,
          provider: "local_speech",
          captureSessionId: "cap-upload",
          burstId: "burst-upload",
        }),
      }),
      expect.objectContaining({
        source_type: "location",
        event_type: "location.fix",
        relation: "nearby_context",
        payload: expect.objectContaining({
          latitude: 23.1425,
          longitude: 113.2401,
          accuracy: 9.7,
          place: { label: "出发点(大兴街店)", address: "Pengcheng East Road" },
        }),
      }),
    ]);
    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toContain("/private/tmp");
    expect(serialized).not.toContain("localFilePath");
    expect(serialized).not.toContain("heading");
    expect(serialized).not.toContain("speed");
  });



  test("regenerates existing evidence windows into stable candidate window upload signals", async () => {
    const { pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "device.sound_scene_run",
      title: "music",
      summary: "Heard music",
      occurred_at: "2026-05-15T10:00:00.000Z",
      payload: {
        schema_version: "sound_scene_run.v1",
        label: "music",
        started_at: "2026-05-15T10:00:00.000Z",
        ended_at: "2026-05-15T10:01:10.000Z",
        durationMs: 70_000,
      },
      dedupe_key: "sound:music:backfill",
    });

    const signals = await pipeline.regenerateDay("2026-05-15");
    const candidateSignals = signals.filter((signal) => signal.kind === AMBIENT_CANDIDATE_WINDOW_KIND);

    expect(candidateSignals.length).toBeGreaterThanOrEqual(1);
    expect(new Set(candidateSignals.map((signal) => signal.dedupe_key)).size).toBe(candidateSignals.length);
    expect(candidateSignals[0]?.payload?.window_type).toBe("sound_context");
  });

  test("backs off local LLM attempts after a model failure", async () => {
    const store = new MemoryTimelineStore();
    let calls = 0;
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineEvent() {
        calls += 1;
        return { ok: false, errorCode: "generation_timeout" };
      },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge, {
      now: () => new Date("2026-05-15T10:10:00.000Z"),
    });

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed a product review and a follow-up item that needs to be sent after the meeting with enough detail for a local model summary.",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: { captureSessionId: "cap-backoff", durationMs: 180_000 },
      dedupe_key: "audio:burst:backoff:1",
    });

    await pipeline.processPendingWindows("2026-05-15");
    await pipeline.processPendingWindows("2026-05-15");

    expect(calls).toBe(1);
    const [window] = await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "transcript_session",
    });
    expect(window).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastErrorCode: "generation_timeout",
    });
  });


  test("merges overlapping sound context into transcript windows", async () => {
    const { store, pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "device.sound_scene_run",
      title: "conversation",
      summary: "Heard conversation",
      occurred_at: "2026-05-15T10:02:30.000Z",
      payload: {
        schema_version: "sound_scene_run.v1",
        label: "conversation",
        started_at: "2026-05-15T10:02:30.000Z",
        ended_at: "2026-05-15T10:04:00.000Z",
        durationMs: 90_000,
        sampleCount: 6,
        maxConfidence: 0.72,
      },
      confidence: 0.72,
      dedupe_key: "sound:conversation:overlap",
    });
    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed product review follow-ups with enough detail for local summarization.",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: { captureSessionId: "cap-sound", durationMs: 120_000 },
      dedupe_key: "audio:burst:sound:1",
    });

    const [window] = await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "transcript_session",
    });

    expect(window?.sourceTypes).toEqual(["transcript", "sound"]);
    expect(window?.rawRefs.map((ref) => ref.sourceType)).toEqual(["transcript", "sound"]);
    expect(window?.compactContext).toContain("Sound context: Heard conversation for 1m 30s, max confidence 72%.");
    expect(await store.listTimelineEvents("2026-05-15", { visibleOnly: true })).toEqual([]);
  });


  test("merges overlapping location, motion, and visit evidence into transcript windows", async () => {
    const { store, pipeline } = makePipeline();

    await pipeline.ingestSignal({
      kind: "device.location",
      title: "Location",
      summary: "Near Office",
      occurred_at: "2026-05-15T10:03:30.000Z",
      payload: { latitude: 31.2, longitude: 121.5, accuracy: 18, place: { label: "Office" } },
      dedupe_key: "location:office:transcript-merge",
    });
    await pipeline.ingestSignal({
      kind: "device.motion_segment",
      title: "Motion: walking",
      summary: "walking",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: {
        schema_version: "motion_segment.v1",
        activity: "walking",
        started_at: "2026-05-15T10:03:00.000Z",
        ended_at: "2026-05-15T10:04:30.000Z",
        durationMs: 90_000,
        sampleCount: 4,
        maxConfidence: "high",
        lastConfidence: "medium",
      },
      dedupe_key: "motion:walking:transcript-merge",
    });
    await pipeline.ingestSignal({
      kind: "device.visit",
      title: "Visit",
      summary: "Stayed at Office",
      occurred_at: "2026-05-15T10:03:30.000Z",
      payload: {
        kind: "departure",
        place: {
          label: "Office",
          place_name: "PIN Office",
          address: "100 Century Ave, Shanghai",
          locality: "Shanghai",
          source: "mapkit+clgeocoder",
        },
        latitude: 31.2,
        longitude: 121.5,
      },
      dedupe_key: "visit:office:transcript-merge",
    });
    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed product review follow-ups with enough detail for local summarization.",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: { captureSessionId: "cap-evidence-merge", durationMs: 120_000 },
      dedupe_key: "audio:burst:evidence-merge:1",
    });

    const [window] = await store.listCandidateWindows({
      localDate: "2026-05-15",
      windowType: "transcript_session",
    });

    expect(window?.compactContext).toContain("Location context:");
    expect(window?.compactContext).toContain("Office");
    expect(window?.compactContext).toContain("Motion context:");
    expect(window?.compactContext).toContain("Place context:");
    expect(window?.sourceTypes).toEqual(expect.arrayContaining(["transcript", "location", "motion", "visit"]));
    expect(window?.generationPolicy).toBe("llm_allowed");
  });


  test("marks synced local LLM events pending when generated content changes", async () => {
    const store = new MemoryTimelineStore();
    let summary = "Initial local summary from the transcript session.";
    const modelBridge: AmbientTimelineModelBridge = {
      async summarizeWindow() { return null; },
      async generateTimelineEvent() {
        return { ok: true, draft: {
          eventType: "conversation",
          title: "Transcript summary",
          summary,
          tags: ["conversation"],
          confidence: 0.7,
          confidenceLabel: "certain",
          salientFacts: [],
        } };
      },
    };
    const pipeline = new LocalAmbientTimelinePipeline(store, modelBridge, {
      now: () => new Date("2026-05-15T10:10:00.000Z"),
    });

    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed a transcript session with enough detail for a local summary and sync update behavior.",
      occurred_at: "2026-05-15T10:00:00.000Z",
      payload: { captureSessionId: "cap-resync", durationMs: 120_000 },
      dedupe_key: "audio:burst:resync:1",
    });
    const [firstSignal] = await pipeline.processPendingWindows("2026-05-15");
    expect(firstSignal).toBeDefined();
    const [firstEvent] = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });
    if (!firstEvent) throw new Error("expected first event");
    await store.markTimelineEventsSynced([firstEvent.id], "2026-05-15T10:11:00.000Z");

    summary = "Updated local summary from the same transcript session.";
    await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Additional transcript content changes the generated summary while preserving stable identity.",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: { captureSessionId: "cap-resync", durationMs: 60_000 },
      dedupe_key: "audio:burst:resync:2",
    });
    const signals = await pipeline.processPendingWindows("2026-05-15");
    const [updatedEvent] = await store.listTimelineEvents("2026-05-15", { visibleOnly: true });

    expect(signals).toHaveLength(1);
    expect(updatedEvent?.id).toBe(firstEvent.id);
    expect(updatedEvent?.syncStatus).toBe("pending");
    expect(updatedEvent?.summary).toBe("Updated local summary from the same transcript session.");
  });

});
