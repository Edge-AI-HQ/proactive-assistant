import { describe, expect, test } from "vitest";

import { SoundRunAggregator } from "./sound-runs";

describe("SoundRunAggregator", () => {
  test("drops short runs that do not meet duration and sample thresholds", () => {
    const aggregator = new SoundRunAggregator();

    aggregator.addSample({ timestamp: 1_000, classifications: [{ label: "music", confidence: 0.8 }] });
    aggregator.addSample({ timestamp: 2_000, classifications: [{ label: "music", confidence: 0.8 }] });

    expect(aggregator.stop()).toBeNull();
  });

  test("emits one stable scene-run identity for eligible runs", () => {
    const aggregator = new SoundRunAggregator();

    expect(aggregator.addSample({ timestamp: 1_000, classifications: [{ label: "music", confidence: 0.8 }] })).toEqual([]);
    expect(aggregator.addSample({ timestamp: 9_000, classifications: [{ label: "music", confidence: 0.7 }] })).toEqual([]);
    const emitted = aggregator.addSample({ timestamp: 17_000, classifications: [{ label: "music", confidence: 0.81 }] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "device.sound_scene_run",
      title: "music",
      dedupe_key: "sound:music:1970-01-01T00:00:01.000Z",
      payload: {
        schema_version: "sound_scene_run.v2",
        label: "music",
        primaryLabel: "music",
        displayLabel: "Music",
        started_at: "1970-01-01T00:00:01.000Z",
        ended_at: "1970-01-01T00:00:17.000Z",
        sampleCount: 3,
        maxConfidence: 0.81,
        sourceConfidence: 0.81,
        topCandidates: [{ label: "music", confidence: 0.81 }],
      },
    });
  });

  test("preserves concrete sound labels and top candidates", () => {
    const aggregator = new SoundRunAggregator();

    aggregator.addSample({ timestamp: 1_000, classifications: [
      { label: "dog bark", confidence: 0.7 },
      { label: "speech", confidence: 0.2 },
    ] });
    aggregator.addSample({ timestamp: 9_000, classifications: [
      { label: "dog bark", confidence: 0.75 },
      { label: "speech", confidence: 0.21 },
    ] });
    const emitted = aggregator.addSample({ timestamp: 17_000, classifications: [
      { label: "dog bark", confidence: 0.81 },
      { label: "speech", confidence: 0.21 },
    ] });

    expect(emitted[0].payload).toMatchObject({
      primaryLabel: "dog_bark",
      displayLabel: "Dog bark",
      topCandidates: [
        { label: "dog_bark", confidence: 0.81 },
        { label: "speech", confidence: 0.21 },
      ],
      sourceConfidence: 0.81,
    });
  });

});
