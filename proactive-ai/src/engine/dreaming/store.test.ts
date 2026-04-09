import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DreamRunStore,
  type DreamProfileDelta,
  type DreamSummary,
} from "./store.js";

const sampleSummary: DreamSummary = {
  kind: "updated",
  text: "Dreaming consolidated recent personal and feedback signals.",
  sourceCount: 3,
  candidateCount: 2,
};

const sampleDelta: DreamProfileDelta = {
  facts: {
    before: { foo: "old" },
    after: { foo: "new" },
  },
  preferences: {
    before: {},
    after: { basket: "work" },
  },
  interests: {
    before: [],
    after: [{ key: "work", kind: "topic", score: 0.8 }],
  },
  snapshots: {
    before: [],
    after: [{ view: "dreaming", summary: "updated" }],
  },
};

describe("DreamRunStore", () => {
  it("creates, completes, and reads a dream run", () => {
    const root = mkdtempSync(join(tmpdir(), "dream-store-"));
    const store = new DreamRunStore(root);
    const run = store.createRun({
      trigger: "manual",
      windowStart: "2026-04-08T00:00:00.000Z",
      windowEnd: "2026-04-09T00:00:00.000Z",
    });

    expect(run.status).toBe("running");

    store.completeRun(run.id, {
      artifactDir: "/tmp/dreams/run_1",
      sourceStats: {
        personal: { status: "ok", count: 4 },
        feedback: { status: "ok", count: 2 },
      },
      summary: sampleSummary,
      profileDelta: sampleDelta,
    });

    const loaded = store.getRun(run.id);
    expect(loaded?.status).toBe("completed");
    expect(loaded?.summaryJson).toEqual(sampleSummary);
    expect(loaded?.profileDeltaJson).toEqual(sampleDelta);
    expect(loaded?.artifactDir).toBe("/tmp/dreams/run_1");
  });

  it("marks older completed runs as superseded", () => {
    const root = mkdtempSync(join(tmpdir(), "dream-store-"));
    const store = new DreamRunStore(root);

    const first = store.createRun({
      trigger: "manual",
      windowStart: "2026-04-08T00:00:00.000Z",
      windowEnd: "2026-04-09T00:00:00.000Z",
    });
    store.completeRun(first.id, {
      artifactDir: "/tmp/dreams/first",
      sourceStats: {},
      summary: sampleSummary,
      profileDelta: sampleDelta,
      completedAt: "2026-04-09T00:00:00.000Z",
    });

    const second = store.createRun({
      trigger: "manual",
      windowStart: "2026-04-09T00:00:00.000Z",
      windowEnd: "2026-04-10T00:00:00.000Z",
    });
    store.completeRun(second.id, {
      artifactDir: "/tmp/dreams/second",
      sourceStats: {},
      summary: sampleSummary,
      profileDelta: sampleDelta,
      completedAt: "2026-04-10T00:00:00.000Z",
    });

    expect(store.getRun(first.id)?.superseded).toBe(true);
    expect(store.getRun(second.id)?.superseded).toBe(false);
  });

  it("records apply timestamps and rejects apply on superseded runs", () => {
    const root = mkdtempSync(join(tmpdir(), "dream-store-"));
    const store = new DreamRunStore(root);

    const first = store.createRun({
      trigger: "manual",
      windowStart: "2026-04-08T00:00:00.000Z",
      windowEnd: "2026-04-09T00:00:00.000Z",
    });
    store.completeRun(first.id, {
      artifactDir: "/tmp/dreams/first",
      sourceStats: {},
      summary: sampleSummary,
      profileDelta: sampleDelta,
      completedAt: "2026-04-09T00:00:00.000Z",
    });

    const second = store.createRun({
      trigger: "manual",
      windowStart: "2026-04-09T00:00:00.000Z",
      windowEnd: "2026-04-10T00:00:00.000Z",
    });
    store.completeRun(second.id, {
      artifactDir: "/tmp/dreams/second",
      sourceStats: {},
      summary: sampleSummary,
      profileDelta: sampleDelta,
      completedAt: "2026-04-10T00:00:00.000Z",
    });

    expect(() => store.markApplied(first.id, "2026-04-10T00:10:00.000Z")).toThrow(/superseded/i);

    store.markApplied(second.id, "2026-04-10T00:10:00.000Z");
    expect(store.getRun(second.id)?.appliedAt).toBe("2026-04-10T00:10:00.000Z");
  });
});
