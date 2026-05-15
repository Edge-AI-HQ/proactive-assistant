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
      occurred_at: "2026-05-15T08:00:00.000Z",
      payload: { metric: "steps", observations: [{ metric: "steps" }] },
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
      occurred_at: "2026-05-15T08:05:00.000Z",
      payload: { metric: "steps", observations: [{ metric: "steps" }] },
      dedupe_key: "health:steps:2",
    });

    expect(signals).toEqual([]);
    expect(await store.listTimelineEvents("2026-05-15", {
      visibleOnly: true,
    })).toEqual([]);
  });
});
