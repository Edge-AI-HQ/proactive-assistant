import { beforeEach, describe, expect, test, vi } from "vitest";

const ambientSummaryBridgeCalls = vi.hoisted(() => ({ local: 0, cloud: 0 }));

vi.mock("@/lib/api", () => ({
  summarizeAmbientWithCloud: vi.fn(),
}));

vi.mock("@/lib/devices", () => ({
  currentDeviceOwnerUserId: vi.fn(async () => "local"),
}));

vi.mock("./summary-bridges", () => ({
  createLocalAmbientSummaryBridge: () => ({
    generateAmbientSummaryEvent: vi.fn(async () => {
      ambientSummaryBridgeCalls.local += 1;
      return { ok: false as const, errorCode: "no_content" };
    }),
  }),
  createCloudFirstAmbientSummaryBridge: () => ({
    generateAmbientSummaryEvent: vi.fn(async () => {
      ambientSummaryBridgeCalls.cloud += 1;
      return { ok: false as const, errorCode: "no_content" };
    }),
  }),
}));

vi.mock("./timeline/scheduled-summary", () => ({
  maybeRunScheduledAmbientSummary: vi.fn(async ({ bridge }) => {
    await bridge.generateAmbientSummaryEvent({
      schemaVersion: "ambient_summary.v1",
      localDate: "2026-05-19",
      generatedAt: "2026-05-19T10:15:00.000Z",
      rawEvents: [],
      recentSummaries: [],
    });
    return { ran: true, status: "failed" };
  }),
}));

import { AmbientRuntime } from "./index";
import { MemoryOutboxStore } from "./outbox";
import type { SourceKey } from "./keys";
import type { AmbientSource } from "./sources/types";

vi.mock("./ingest-bridge", () => ({
  ingestBatch: vi.fn(async () => ({
    inserted: 0,
    duplicate: 0,
    rejected: 0,
    parseFailed: 0,
    retryableFailed: 0,
    raw: null,
  })),
}));

class FakeSource implements AmbientSource {
  readonly label: string;
  started = false;
  startCalls = 0;
  stopCalls = 0;
  refreshCalls = 0;
  failNextStart = false;
  startWaiter: Promise<void> | null = null;

  constructor(readonly key: SourceKey) {
    this.label = key;
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startWaiter) await this.startWaiter;
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("start failed");
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.started = false;
  }

  async refresh(): Promise<void> {
    this.refreshCalls += 1;
  }
}

function makeRuntime(source: FakeSource): AmbientRuntime {
  return new AmbientRuntime({
    sources: [source],
    outbox: new MemoryOutboxStore(),
    enableTimers: false,
  });
}

describe("AmbientRuntime source reconciliation", () => {
  beforeEach(() => {
    ambientSummaryBridgeCalls.local = 0;
    ambientSummaryBridgeCalls.cloud = 0;
    localStorage.clear();
  });
  test("retries a desired source after an earlier start failure", async () => {
    const source = new FakeSource("sound_classifier");
    source.failNextStart = true;
    const runtime = makeRuntime(source);

    await runtime.reconcileEnabledSources(["sound_classifier"]);

    expect(source.startCalls).toBe(1);
    expect(runtime.status().sources[0]).toMatchObject({
      enabled: false,
      lastError: "start failed",
    });

    await runtime.refreshActiveSources();

    expect(source.startCalls).toBe(2);
    expect(runtime.status().sources[0]).toMatchObject({
      enabled: true,
      lastError: null,
    });
  });

  test("refreshes an already running desired source", async () => {
    const source = new FakeSource("sound_classifier");
    const runtime = makeRuntime(source);

    await runtime.reconcileEnabledSources(["sound_classifier"]);
    await runtime.refreshActiveSources();

    expect(source.startCalls).toBe(1);
    expect(source.refreshCalls).toBe(1);
    expect(source.stopCalls).toBe(0);
  });

  test("stops a source once it is removed from the desired set", async () => {
    const source = new FakeSource("sound_classifier");
    const runtime = makeRuntime(source);

    await runtime.reconcileEnabledSources(["sound_classifier"]);
    await runtime.reconcileEnabledSources([]);
    await runtime.refreshActiveSources();

    expect(source.startCalls).toBe(1);
    expect(source.stopCalls).toBe(1);
    expect(source.refreshCalls).toBe(0);
    expect(runtime.status().sources[0]).toMatchObject({
      enabled: false,
      lastError: null,
    });
  });

  test("reruns reconciliation immediately when desired sources change mid-start", async () => {
    const source = new FakeSource("sound_classifier");
    let releaseStart: () => void = () => { };
    source.startWaiter = new Promise((resolve) => {
      releaseStart = resolve;
    });
    const runtime = makeRuntime(source);

    const startPass = runtime.reconcileEnabledSources(["sound_classifier"]);
    await Promise.resolve();
    expect(source.startCalls).toBe(1);
    const stopPass = runtime.reconcileEnabledSources([]);
    releaseStart();
    await Promise.all([startPass, stopPass]);

    expect(source.startCalls).toBe(1);
    expect(source.stopCalls).toBe(1);
    expect(runtime.status().sources[0]).toMatchObject({
      enabled: false,
      lastError: null,
    });
  });

  test("waits for in-flight reconciliation before reporting status to overlapping callers", async () => {
    const source = new FakeSource("sound_classifier");
    let releaseStart: () => void = () => { };
    source.startWaiter = new Promise((resolve) => {
      releaseStart = resolve;
    });
    const runtime = makeRuntime(source);

    const firstPass = runtime.reconcileEnabledSources(["sound_classifier"]);
    await Promise.resolve();
    let secondResolved = false;
    const secondPass = runtime.reconcileEnabledSources(["sound_classifier"]).then(() => {
      secondResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);
    releaseStart();
    await Promise.all([firstPass, secondPass]);

    expect(secondResolved).toBe(true);
    expect(runtime.status().sources[0]).toMatchObject({
      enabled: true,
      lastError: null,
    });
  });

  test("refreshTimeline enqueues generated timeline signals", async () => {
    const source = new FakeSource("sound_classifier");
    const outbox = new MemoryOutboxStore();
    const timelinePipeline = {
      ingestSignal: vi.fn(),
      regenerateDay: vi.fn(async () => [{
        kind: "ambient.timeline_event",
        title: "Local summary",
        summary: "Generated locally",
        occurred_at: "2026-05-15T10:00:00.000Z",
        dedupe_key: "ambient:timeline:2026-05-15:llm:win_1",
        payload: { local_event_id: "evt_1" },
      }]),
      processPendingWindows: vi.fn(),
      generateContextSnapshot: vi.fn(async () => null),
    };
    const runtime = new AmbientRuntime({
      sources: [source],
      outbox,
      enableTimers: false,
      timelinePipeline,
    });

    await runtime.refreshTimeline("2026-05-15");

    expect(timelinePipeline.regenerateDay).toHaveBeenCalledWith("2026-05-15", { includeRecentPending: true, forceReady: false });
    expect(await outbox.count()).toBe(1);
    expect(runtime.status().outboxPendingCount).toBe(1);
  });

});


describe("AmbientRuntime scheduled summary routing", () => {
  beforeEach(() => {
    ambientSummaryBridgeCalls.local = 0;
    ambientSummaryBridgeCalls.cloud = 0;
    localStorage.clear();
  });
  test("uses local summary bridge when uploads are locked", async () => {
    const source = new FakeSource("sound_classifier");
    const runtime = new AmbientRuntime({
      sources: [source],
      outbox: new MemoryOutboxStore(),
      enableTimers: false,
    });
    runtime.setUploadsLocked(true);

    await runtime.runScheduledTimelineSummary(new Date("2026-05-19T10:15:00.000Z"));

    expect(ambientSummaryBridgeCalls.local).toBe(1);
    expect(ambientSummaryBridgeCalls.cloud).toBe(0);
  });

  test("uses Ambient summary bridge when uploads are unlocked and preference allows cloud", async () => {
    localStorage.setItem("pin.ambient.summaryPreference", "cloud_when_unlocked");
    const source = new FakeSource("sound_classifier");
    const runtime = new AmbientRuntime({
      sources: [source],
      outbox: new MemoryOutboxStore(),
      enableTimers: false,
    });

    await runtime.runScheduledTimelineSummary(new Date("2026-05-19T10:15:00.000Z"));

    expect(ambientSummaryBridgeCalls.cloud).toBe(1);
    expect(ambientSummaryBridgeCalls.local).toBe(0);
  });
});
