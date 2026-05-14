import { describe, expect, it } from "vitest";
import { dateRangeOrderError, dayEndIso, dayStartIso } from "./dateRange";

describe("date range helpers", () => {
  it("uses the full local day for date filters", () => {
    const start = new Date(dayStartIso("2026-05-14") ?? "");
    const end = new Date(dayEndIso("2026-05-14") ?? "");

    expect(start.getMilliseconds()).toBe(0);
    expect(end.getMilliseconds()).toBe(999);
  });

  it("omits empty date filters", () => {
    expect(dayStartIso("")).toBeUndefined();
    expect(dayEndIso("")).toBeUndefined();
  });

  it("omits malformed or impossible date filters instead of throwing", () => {
    expect(dayStartIso("not-a-date")).toBeUndefined();
    expect(dayEndIso("2026-13-99")).toBeUndefined();
    expect(dayStartIso("2026-02-31")).toBeUndefined();
  });

  it("reports reversed date ranges without treating malformed dates as conflicts", () => {
    expect(dateRangeOrderError("2026-05-15", "2026-05-14", "完成时间")).toBe("完成时间开始日期不能晚于结束日期。");
    expect(dateRangeOrderError("2026-05-14", "2026-05-14", "完成时间")).toBeNull();
    expect(dateRangeOrderError("not-a-date", "2026-05-14", "完成时间")).toBeNull();
  });
});
