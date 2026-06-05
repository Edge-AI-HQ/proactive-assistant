import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  init: vi.fn(async () => undefined),
  listCandidateWindows: vi.fn(async (_filter?: unknown) => [] as unknown[]),
  listRawEvents: vi.fn(async (_filter?: unknown) => [] as unknown[]),
}));

vi.mock("@/lib/platform", () => ({ isNative: true }));

vi.mock("@/services/ambient/timeline", async () => {
  const actual = await vi.importActual<typeof import("@/services/ambient/timeline")>(
    "@/services/ambient/timeline",
  );
  return {
    ...actual,
    getAmbientTimelineStore: () => storeMock,
    todayLocalDate: () => "2026-05-17",
  };
});

import { listLiveSessionRawContextEvents, useAmbientLiveSession } from "./useAmbientLiveSession";
import {
  applyAmbientLiveTranscriptUpdate,
  resetAmbientLiveTranscriptForTest,
} from "@/services/ambient/live-transcript-store";
import type { AmbientRawEvent, AmbientSourceType } from "@/services/ambient/timeline";

beforeEach(() => {
  storeMock.init.mockClear();
  storeMock.listCandidateWindows.mockClear();
  storeMock.listRawEvents.mockClear();
  storeMock.init.mockResolvedValue(undefined);
  storeMock.listCandidateWindows.mockResolvedValue([]);
  storeMock.listRawEvents.mockResolvedValue([]);
  resetAmbientLiveTranscriptForTest();
});

afterEach(() => {
  resetAmbientLiveTranscriptForTest();
  vi.useRealTimers();
});

describe("useAmbientLiveSession", () => {
  test("renders existing real session assists immediately instead of staging from one", async () => {
    vi.setSystemTime(new Date("2026-05-17T10:01:00.000Z"));
    applyAmbientLiveTranscriptUpdate({
      captureSessionId: "cap-live",
      id: "burst-1",
      text: "今天早上已经转录出来的第一段",
      source: "cloud_whisper",
      receivedAt: Date.parse("2026-05-17T10:00:00.000Z"),
    });
    applyAmbientLiveTranscriptUpdate({
      captureSessionId: "cap-live",
      id: "burst-2",
      text: "今天早上已经转录出来的第二段",
      source: "cloud_whisper",
      receivedAt: Date.parse("2026-05-17T10:00:30.000Z"),
    });

    const { result } = renderHook(() => useAmbientLiveSession({ ambientOn: true }));

    await waitFor(() => {
      expect(result.current.isRealSession).toBe(true);
      expect(result.current.session?.assists).toHaveLength(2);
      expect(result.current.previewVisibleCount).toBe(2);
    });
  });

  test("hydrates today's persisted transcripts into the live session snapshot", async () => {
    storeMock.listRawEvents.mockImplementation(async (filter?: unknown) => {
      const sourceType = (filter as { sourceType?: AmbientSourceType } | undefined)?.sourceType;
      return sourceType === "transcript"
        ? [
            makeTranscriptRaw("raw-1", "2026-05-17T00:05:00.000Z", "Transcript segment: midnight transcript"),
            makeTranscriptRaw("raw-2", "2026-05-17T10:10:00.000Z", "Transcript segment: current transcript"),
          ]
        : [];
    });

    const { result } = renderHook(() => useAmbientLiveSession({ ambientOn: true }));

    await waitFor(() => {
      expect(result.current.session?.assists.map((item) => item.text)).toEqual([
        "midnight transcript",
        "current transcript",
      ]);
    });
    expect(result.current.history).toEqual([]);
    expect(result.current.previewVisibleCount).toBe(2);
    expect(storeMock.listCandidateWindows).toHaveBeenCalledWith({
      localDate: "2026-05-17",
      limit: 10_000,
    });
    expect(storeMock.listRawEvents).toHaveBeenCalledWith({
      localDate: "2026-05-17",
      sourceType: "transcript",
      eventType: "transcript.ready",
      order: "asc",
      limit: 10_000,
    });
  });
});

describe("listLiveSessionRawContextEvents", () => {
  test("queries latest raw context per non-transcript source", async () => {
    const rowsBySource = new Map<AmbientSourceType, AmbientRawEvent[]>([
      ["health", [makeRaw("health")]],
      ["location", [makeRaw("location")]],
      ["motion", [makeRaw("motion")]],
    ]);
    const listRawEvents = vi.fn(async (filter: {
      localDate?: string;
      sourceType?: AmbientSourceType;
      eventType?: string;
      limit?: number;
      order?: "asc" | "desc";
    }) => rowsBySource.get(filter.sourceType as AmbientSourceType) ?? []);

    const rows = await listLiveSessionRawContextEvents({ listRawEvents }, "2026-05-17");

    expect(listRawEvents.mock.calls.map(([filter]) => filter)).toEqual([
      { localDate: "2026-05-17", sourceType: "health", order: "desc", limit: 1 },
      { localDate: "2026-05-17", sourceType: "location", order: "desc", limit: 1 },
      { localDate: "2026-05-17", sourceType: "visit", order: "desc", limit: 1 },
      { localDate: "2026-05-17", sourceType: "motion", order: "desc", limit: 1 },
      { localDate: "2026-05-17", sourceType: "sound", order: "desc", limit: 1 },
      { localDate: "2026-05-17", sourceType: "calendar", order: "desc", limit: 1 },
    ]);
    expect(rows.map((row) => row.sourceType)).toEqual(["health", "location", "motion"]);
  });
});

function makeRaw(sourceType: AmbientSourceType): AmbientRawEvent {
  return {
    id: `raw-${sourceType}`,
    localUserId: "local",
    deviceId: null,
    sourceType,
    eventType: `${sourceType}.update`,
    sourceVersion: "test",
    occurredAt: "2026-05-17T06:00:00.000Z",
    collectedAt: "2026-05-17T06:00:00.000Z",
    timezone: "Asia/Shanghai",
    localDate: "2026-05-17",
    payload: {},
    compactText: `${sourceType} update`,
    confidence: 0.8,
    sensitivity: "normal",
    permissionState: null,
    ttlExpiresAt: null,
    contentHash: sourceType,
    dedupeKey: sourceType,
    processingStatus: "new",
    createdAt: "2026-05-17T06:00:00.000Z",
    updatedAt: "2026-05-17T06:00:00.000Z",
  };
}

function makeTranscriptRaw(id: string, occurredAt: string, compactText: string): AmbientRawEvent {
  return {
    ...makeRaw("transcript"),
    id,
    eventType: "transcript.ready",
    occurredAt,
    collectedAt: occurredAt,
    localDate: "2026-05-17",
    payload: {
      captureSessionId: "cap-today",
      burstId: id,
      provider: "cloud_whisper",
    },
    compactText,
    contentHash: id,
    dedupeKey: `transcript:${id}`,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}
