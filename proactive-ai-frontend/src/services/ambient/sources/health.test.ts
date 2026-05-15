import { beforeEach, describe, expect, test, vi } from "vitest";

import { HealthSource } from "./health";
import type { SourceContext } from "./types";

const { ambientAiMock, removeMocks } = vi.hoisted(() => {
  const removeMocks = [vi.fn(), vi.fn(), vi.fn()];
  return {
    removeMocks,
    ambientAiMock: {
      health: {
        requestPermissions: vi.fn(),
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
      },
      addListener: vi.fn(async () => ({
        remove: removeMocks.shift() ?? vi.fn(),
      })),
    },
  };
});

vi.mock("@pin/capacitor-ambient-ai", () => ({
  AmbientAi: ambientAiMock,
}));

function makeContext() {
  const pushed: unknown[] = [];
  const ctx: SourceContext = {
    push: (item) => pushed.push(item),
    onEvent: vi.fn(),
  };
  return { ctx, pushed };
}

describe("HealthSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeMocks.splice(0, removeMocks.length, vi.fn(), vi.fn(), vi.fn());
    ambientAiMock.addListener.mockImplementation(async () => ({
      remove: removeMocks.shift() ?? vi.fn(),
    }));
    ambientAiMock.health.requestPermissions.mockResolvedValue({ health: "granted" });
    ambientAiMock.health.startMonitoring.mockResolvedValue(undefined);
    ambientAiMock.health.stopMonitoring.mockResolvedValue(undefined);
  });

  test("converts steps into a full-sync health observation", () => {
    const { ctx, pushed } = makeContext();
    const source = new HealthSource(ctx);

    source.handleStepsForTest({
      stepsToday: 8120.4,
      timestamp: Date.parse("2026-05-13T08:00:00.000Z"),
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      kind: "health.observation",
      sync_mode: "full",
      title: "Daily steps",
      summary: "8120 steps today",
      occurred_at: "2026-05-13T08:00:00.000Z",
      payload: {
        schema_version: "health_observation.v1",
        source_app: "healthkit",
        metric: "steps",
        local_date: "2026-05-13",
        observations: [{
          schema_version: "health_observation.v1",
          observation_type: "daily_summary",
          metric: "steps",
          value: 8120,
          unit: "count",
          local_date: "2026-05-13",
          source_app: "healthkit",
          occurred_at: "2026-05-13T08:00:00.000Z",
          dedupe_key: "ios:health:steps:2026-05-13",
        }],
      },
    });
    expect(ctx.onEvent).toHaveBeenCalledWith("health", "8120 steps today");
  });


  test("ignores zero-step updates without pushing or updating last event", () => {
    const { ctx, pushed } = makeContext();
    const source = new HealthSource(ctx);

    source.handleStepsForTest({
      stepsToday: 0,
      timestamp: Date.parse("2026-05-13T08:00:00.000Z"),
    });

    expect(pushed).toEqual([]);
    expect(ctx.onEvent).not.toHaveBeenCalled();
  });

  test("converts heart rate into a metric-scoped full-sync window summary", () => {
    const { pushed } = makeContext();
    const source = new HealthSource({
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    });

    source.handleHeartRateForTest({
      avgBpm6h: 71.6,
      timestamp: Date.parse("2026-05-13T10:00:00.000Z"),
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      kind: "health.observation",
      sync_mode: "full",
      payload: {
        metric: "heart_rate",
        local_date: "2026-05-13",
        observations: [{
          observation_type: "window_summary",
          metric: "heart_rate",
          value: 72,
          unit: "bpm",
          source_app: "healthkit",
        }],
      },
    });
  });

  test("converts sleep into an incremental session observation", () => {
    const { pushed } = makeContext();
    const source = new HealthSource({
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    });

    source.handleSleepForTest({
      durationMin: 432,
      endedAt: "2026-05-13T06:30:00.000Z",
      timestamp: Date.parse("2026-05-13T06:31:00.000Z"),
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      kind: "health.observation",
      sync_mode: "incremental",
      title: "Sleep session",
      occurred_at: "2026-05-13T06:30:00.000Z",
      payload: {
        metric: "sleep",
        local_date: "2026-05-13",
        observations: [{
          observation_type: "session",
          metric: "sleep",
          value: 432,
          unit: "minute",
          dedupe_key: "ios:health:sleep:2026-05-13T06:30:00.000Z",
        }],
      },
    });
  });

  test("permission denied fails start without listeners or queued items", async () => {
    ambientAiMock.health.requestPermissions.mockResolvedValueOnce({ health: "denied" });
    const { ctx, pushed } = makeContext();
    const source = new HealthSource(ctx);

    await expect(source.start()).rejects.toThrow("health permission denied");

    expect(ambientAiMock.addListener).not.toHaveBeenCalled();
    expect(ambientAiMock.health.startMonitoring).not.toHaveBeenCalled();
    expect(source.isStarted()).toBe(false);
    expect(pushed).toEqual([]);
  });

  test("unavailable HealthKit fails start and removes registered listeners", async () => {
    const removeA = vi.fn();
    const removeB = vi.fn();
    const removeC = vi.fn();
    ambientAiMock.addListener
      .mockResolvedValueOnce({ remove: removeA })
      .mockResolvedValueOnce({ remove: removeB })
      .mockResolvedValueOnce({ remove: removeC });
    ambientAiMock.health.startMonitoring.mockRejectedValueOnce(
      new Error("HealthKit not available on this device"),
    );
    const { pushed } = makeContext();
    const source = new HealthSource({
      push: (item) => pushed.push(item),
      onEvent: vi.fn(),
    });

    await expect(source.start()).rejects.toThrow("HealthKit not available");

    expect(removeA).toHaveBeenCalled();
    expect(removeB).toHaveBeenCalled();
    expect(removeC).toHaveBeenCalled();
    expect(source.isStarted()).toBe(false);
    expect(pushed).toEqual([]);
  });
});
