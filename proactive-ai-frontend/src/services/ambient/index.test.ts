import { describe, expect, test, vi } from "vitest";

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
    let releaseStart: () => void = () => {};
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
});
