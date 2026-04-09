import { describe, expect, it } from "vitest";

import { getDreamingSchedule, isDreamingDue, resolveDreamingTimezone } from "./schedule.js";

describe("dreaming schedule", () => {
  it("returns the fixed daily 6:00 schedule", () => {
    expect(getDreamingSchedule("Asia/Shanghai")).toEqual({
      type: "daily",
      hour: 6,
      minute: 0,
      timezone: "Asia/Shanghai",
    });
  });

  it("is due after 6:00 when there is no prior auto run", () => {
    const now = new Date("2026-04-09T00:05:00.000Z");
    expect(isDreamingDue({
      now,
      timezone: "Asia/Shanghai",
      lastAutoCompletedAt: null,
    })).toBe(true);
  });

  it("is not due before 6:00 in the target timezone", () => {
    const now = new Date("2026-04-08T21:30:00.000Z");
    expect(isDreamingDue({
      now,
      timezone: "Asia/Shanghai",
      lastAutoCompletedAt: null,
    })).toBe(false);
  });

  it("is not due when a successful auto run already happened on the same local day", () => {
    const now = new Date("2026-04-09T01:30:00.000Z");
    const lastAutoCompletedAt = "2026-04-09T00:15:00.000Z";
    expect(isDreamingDue({
      now,
      timezone: "Asia/Shanghai",
      lastAutoCompletedAt,
    })).toBe(false);
  });

  it("prefers the profile timezone and falls back to the system timezone", () => {
    expect(resolveDreamingTimezone("Asia/Shanghai", "America/Los_Angeles")).toBe("Asia/Shanghai");
    expect(resolveDreamingTimezone(null, "America/Los_Angeles")).toBe("America/Los_Angeles");
  });
});
