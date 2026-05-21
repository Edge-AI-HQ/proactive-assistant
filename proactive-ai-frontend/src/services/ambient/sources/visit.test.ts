import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { VisitSource } from "./visit";
import type { SourceContext } from "./types";

const { ambientAiMock, listeners } = vi.hoisted(() => {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    listeners,
    ambientAiMock: {
      visit: {
        requestPermissions: vi.fn(),
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
        drainPendingVisits: vi.fn(),
        ackPendingVisits: vi.fn(),
      },
      addListener: vi.fn(async (_eventName: string, listener: (event: unknown) => void) => {
        listeners.push(listener);
        return { remove: vi.fn() };
      }),
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
    pushDurable: vi.fn(async (item) => {
      pushed.push(item);
    }),
    onEvent: vi.fn(),
  };
  return { ctx, pushed };
}

describe("VisitSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.splice(0, listeners.length);
    ambientAiMock.visit.requestPermissions.mockResolvedValue({ location: "always" });
    ambientAiMock.visit.startMonitoring.mockResolvedValue(undefined);
    ambientAiMock.visit.stopMonitoring.mockResolvedValue(undefined);
    ambientAiMock.visit.drainPendingVisits.mockResolvedValue({ visits: [] });
    ambientAiMock.visit.ackPendingVisits.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("requires Always location permission before monitoring visits", async () => {
    ambientAiMock.visit.requestPermissions.mockResolvedValue({ location: "when_in_use" });
    const { ctx } = makeContext();
    const source = new VisitSource(ctx);

    await expect(source.start()).rejects.toThrow(
      "location permission when_in_use; always required for visit",
    );

    expect(ambientAiMock.visit.startMonitoring).not.toHaveBeenCalled();
  });

  test("drains pending native visits and acks after durable local ingest", async () => {
    ambientAiMock.visit.drainPendingVisits.mockResolvedValue({
      visits: [{
        id: "visit:1",
        payload: {
          id: "visit:1",
          arrivalAt: Date.parse("2026-05-20T08:00:00.000Z"),
          departureAt: null,
          latitude: 37.7749,
          longitude: -122.4194,
          accuracy: 42,
          placeStatus: "pending",
        },
      }],
    });
    const { ctx, pushed } = makeContext();
    const source = new VisitSource(ctx);

    await source.start();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      kind: "device.visit",
      dedupe_key: "visit:visit:1",
      payload: {
        native_id: "visit:1",
        place_status: "pending",
      },
    });
    expect(ambientAiMock.visit.ackPendingVisits).toHaveBeenCalledWith({ ids: ["visit:1"] });
  });

  test("keeps monitoring but does not ack pending visits when durable ingest fails", async () => {
    ambientAiMock.visit.drainPendingVisits.mockResolvedValue({
      visits: [{
        id: "visit:1",
        payload: {
          id: "visit:1",
          arrivalAt: Date.parse("2026-05-20T08:00:00.000Z"),
          departureAt: null,
          latitude: 37.7749,
          longitude: -122.4194,
          accuracy: 42,
        },
      }],
    });
    const ctx: SourceContext = {
      push: vi.fn(),
      pushDurable: vi.fn(async () => {
        throw new Error("sqlite failed");
      }),
      onEvent: vi.fn(),
    };
    const source = new VisitSource(ctx);

    await expect(source.start()).resolves.toBeUndefined();

    expect(ambientAiMock.visit.ackPendingVisits).not.toHaveBeenCalled();
    expect(source.isStarted()).toBe(true);
  });

  test("waits for resolved realtime visit before durable ingest and ack", async () => {
    const { ctx, pushed } = makeContext();
    const source = new VisitSource(ctx);
    await source.start();

    listeners[0]?.({
      id: "visit:live",
      arrivalAt: Date.parse("2026-05-20T08:00:00.000Z"),
      departureAt: null,
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 42,
      placeStatus: "pending",
    });
    await vi.waitFor(() => {
      expect(pushed).toHaveLength(0);
    });

    listeners[0]?.({
      id: "visit:live",
      arrivalAt: Date.parse("2026-05-20T08:00:00.000Z"),
      departureAt: null,
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 42,
      placeStatus: "resolved",
      place: { label: "Ferry Building" },
    });

    await vi.waitFor(() => {
      expect(pushed).toHaveLength(1);
    });
    expect(pushed[0]).toMatchObject({
      summary: "Arrived @ Ferry Building (±42m)",
      dedupe_key: "visit:visit:live",
      payload: {
        native_id: "visit:live",
        place_status: "resolved",
        place: { label: "Ferry Building" },
      },
    });
    await vi.waitFor(() => {
      expect(ambientAiMock.visit.ackPendingVisits).toHaveBeenCalledTimes(1);
    });
    expect(ambientAiMock.visit.ackPendingVisits).toHaveBeenCalledWith({ ids: ["visit:live"] });
  });
});
