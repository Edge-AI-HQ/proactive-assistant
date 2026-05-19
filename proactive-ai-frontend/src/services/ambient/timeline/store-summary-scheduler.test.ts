import { describe, expect, test } from "vitest";

import { MemoryTimelineStore } from "./store";
import { DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE } from "./summary-scheduler";

describe("summary scheduler state persistence", () => {
  test("persists scheduler state in the timeline store", async () => {
    const store = new MemoryTimelineStore();

    expect(await store.getSummarySchedulerState()).toEqual(DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE);

    await store.setSummarySchedulerState({
      ...DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
      lastSummarySuccessAt: "2026-05-19T10:00:00.000Z",
      retryCount: 2,
      lastErrorCode: "generation_failed",
    });

    expect(await store.getSummarySchedulerState()).toMatchObject({
      lastSummarySuccessAt: "2026-05-19T10:00:00.000Z",
      retryCount: 2,
      lastErrorCode: "generation_failed",
    });
  });
});
