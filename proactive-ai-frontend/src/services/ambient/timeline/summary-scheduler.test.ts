import { describe, expect, test } from "vitest";

import {
  DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
  recordAmbientSummaryFailure,
  recordAmbientSummaryModelError,
  recordAmbientSummaryNoContent,
  recordAmbientSummarySuccess,
  shouldRunAmbientSummary,
} from "./summary-scheduler";

describe("ambient summary scheduler", () => {
  const baseNow = new Date("2026-05-19T12:00:00.000Z");

  test("runs when no successful or no-content summary has been recorded", () => {
    expect(shouldRunAmbientSummary(DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE, baseNow)).toBe(true);
  });

  test("waits until fifteen minutes after the last effective summary", () => {
    const state = recordAmbientSummarySuccess(DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE, baseNow);

    expect(shouldRunAmbientSummary(state, new Date("2026-05-19T12:14:59.000Z"))).toBe(false);
    expect(shouldRunAmbientSummary(state, new Date("2026-05-19T12:15:00.000Z"))).toBe(true);
  });

  test("treats no-content checks as the summary cadence anchor", () => {
    const state = recordAmbientSummaryNoContent(DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE, baseNow);

    expect(state.lastNoContentAt).toBe("2026-05-19T12:00:00.000Z");
    expect(shouldRunAmbientSummary(state, new Date("2026-05-19T12:05:00.000Z"))).toBe(false);
  });

  test("records retryable failures with bounded retry backoff", () => {
    const first = recordAmbientSummaryFailure(
      DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
      baseNow,
      "generation_timeout",
      "timed out",
    );
    const second = recordAmbientSummaryFailure(first, new Date("2026-05-19T12:01:00.000Z"), "invalid_json");
    const third = recordAmbientSummaryFailure(second, new Date("2026-05-19T12:04:00.000Z"), "invalid_shape");

    expect(first).toMatchObject({
      retryCount: 1,
      nextRetryAt: "2026-05-19T12:01:00.000Z",
      lastErrorCode: "generation_timeout",
      lastErrorMessage: "timed out",
    });
    expect(second.retryCount).toBe(2);
    expect(second.nextRetryAt).toBe("2026-05-19T12:04:00.000Z");
    expect(third.retryCount).toBe(3);
    expect(third.nextRetryAt).toBe("2026-05-19T12:19:00.000Z");
    expect(shouldRunAmbientSummary(third, new Date("2026-05-19T12:10:00.000Z"))).toBe(false);
  });

  test("model readiness errors do not consume retry attempts", () => {
    const state = recordAmbientSummaryModelError(
      DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
      baseNow,
      "model_not_present",
    );

    expect(state.retryCount).toBe(0);
    expect(state.nextRetryAt).toBeNull();
    expect(state.lastErrorCode).toBe("model_not_present");
    expect(state.lastSummarySuccessAt).toBeNull();
  });
});
