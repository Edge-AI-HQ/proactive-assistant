import { describe, expect, test } from "vitest";

import {
  DEVICE_TIMELINE_QUICK_FILTERS,
  formatLocalDateInput,
  getDeviceTimelineDateRange,
} from "./device-timeline-filters";

describe("device timeline date filters", () => {
  test("all days does not constrain the query", () => {
    expect(getDeviceTimelineDateRange("all", "", new Date(2026, 3, 30))).toEqual({
      label: "All days",
    });
  });

  test("custom day maps to the full local day", () => {
    const range = getDeviceTimelineDateRange("custom", "2026-04-29");

    expect(range).toEqual({
      since: new Date(2026, 3, 29).toISOString(),
      until: new Date(2026, 3, 29, 23, 59, 59, 999).toISOString(),
      label: "2026-04-29",
    });
  });

  test("last 7 days includes today plus the previous 6 local days", () => {
    const range = getDeviceTimelineDateRange("last7d", "", new Date(2026, 3, 30, 12, 30));

    expect(range).toEqual({
      since: new Date(2026, 3, 24).toISOString(),
      until: new Date(2026, 3, 30, 23, 59, 59, 999).toISOString(),
      label: "Last 7 days",
    });
  });

  test("formats local dates for date inputs", () => {
    expect(formatLocalDateInput(new Date(2026, 3, 9))).toBe("2026-04-09");
  });

  test("quick filters stay focused on all days and today", () => {
    expect(DEVICE_TIMELINE_QUICK_FILTERS.map((filter) => filter.value)).toEqual(["all", "today"]);
  });
});
