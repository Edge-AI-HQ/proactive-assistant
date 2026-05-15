import { describe, expect, test } from "vitest";

import { LocalAmbientTimelinePipeline } from "./pipeline";
import { MemoryTimelineStore } from "./store";
import { AMBIENT_TIMELINE_KIND } from "./types";

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

    expect(signals).toEqual([]);
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

    expect(signals).toEqual([]);
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

  test("keeps transcript sessions as pending windows in milestone A", async () => {
    const { store, pipeline } = makePipeline();

    const signals = await pipeline.ingestSignal({
      kind: "session_summary",
      title: "Voice summary",
      summary: "Discussed a product review and a follow-up item.",
      occurred_at: "2026-05-15T10:03:00.000Z",
      payload: {
        captureSessionId: "cap-1",
        durationMs: 180_000,
      },
      dedupe_key: "audio:burst:1",
    });

    expect(signals).toEqual([]);
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
});
