import { describe, expect, test, vi } from "vitest";

import { listLiveSessionRawContextEvents } from "./useAmbientLiveSession";
import type { AmbientRawEvent, AmbientSourceType } from "@/services/ambient/timeline";

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
