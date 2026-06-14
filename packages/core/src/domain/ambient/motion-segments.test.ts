import { describe, expect, test } from "vitest";

import { MotionSegmentAggregator } from "./motion-segments";

describe("MotionSegmentAggregator", () => {
  test("does not emit for confidence-only changes inside the same activity", () => {
    const aggregator = new MotionSegmentAggregator();

    expect(aggregator.addSample({
      type: "stationary",
      confidence: "low",
      timestamp: Date.parse("2026-05-15T08:00:00.000Z"),
    })).toEqual([]);
    expect(aggregator.addSample({
      type: "stationary",
      confidence: "high",
      timestamp: Date.parse("2026-05-15T08:00:10.000Z"),
    })).toEqual([]);
  });


  test("emits a periodic update for a sustained same-activity segment", () => {
    const aggregator = new MotionSegmentAggregator({ periodicUpdateMs: 60_000 });

    aggregator.addSample({
      type: "automotive",
      confidence: "high",
      timestamp: Date.parse("2026-05-15T08:00:00.000Z"),
    });
    const emitted = aggregator.addSample({
      type: "automotive",
      confidence: "medium",
      timestamp: Date.parse("2026-05-15T08:01:05.000Z"),
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "device.motion_segment",
      title: "Motion: automotive",
      dedupe_key: "motion:automotive:2026-05-15T08:00:00.000Z",
      payload: {
        schema_version: "motion_segment.v1",
        activity: "automotive",
        started_at: "2026-05-15T08:00:00.000Z",
        ended_at: "2026-05-15T08:01:05.000Z",
        durationMs: 65_000,
        sampleCount: 2,
        maxConfidence: "high",
        lastConfidence: "medium",
      },
    });
  });

  test("merges a short bounced transition back into the current segment", () => {
    const aggregator = new MotionSegmentAggregator();

    aggregator.addSample({ type: "walking", confidence: "high", timestamp: 1_000 });
    expect(aggregator.addSample({ type: "stationary", confidence: "medium", timestamp: 10_000 })).toEqual([]);
    expect(aggregator.addSample({ type: "walking", confidence: "medium", timestamp: 20_000 })).toEqual([]);
    const finalized = aggregator.stop();

    expect(finalized).toMatchObject({
      kind: "device.motion_segment",
      title: "Motion: walking",
      payload: {
        schema_version: "motion_segment.v1",
        activity: "walking",
        sampleCount: 2,
      },
    });
  });

  test("finalizes the current segment when a new type is confirmed", () => {
    const aggregator = new MotionSegmentAggregator();

    aggregator.addSample({ type: "stationary", confidence: "high", timestamp: 1_000 });
    aggregator.addSample({ type: "walking", confidence: "medium", timestamp: 40_000 });
    const emitted = aggregator.addSample({ type: "walking", confidence: "high", timestamp: 45_000 });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "device.motion_segment",
      title: "Motion: stationary",
      payload: {
        schema_version: "motion_segment.v1",
        activity: "stationary",
      },
    });
    expect(aggregator.stop()).toMatchObject({
      kind: "device.motion_segment",
      title: "Motion: walking",
    });
  });
});
