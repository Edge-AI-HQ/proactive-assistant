import { describe, expect, it } from "vitest";
import { formatDateTimeOrDash } from "./dateFormat";

describe("date formatting helpers", () => {
  it("formats valid timestamps with the requested date options", () => {
    expect(formatDateTimeOrDash("2026-05-14T10:05:00.000Z", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "UTC",
    }, "zh-CN")).toBe("05/14");
  });

  it("does not throw on empty or malformed timestamps from backend data", () => {
    expect(formatDateTimeOrDash(null, { day: "numeric" })).toBe("-");
    expect(formatDateTimeOrDash("", { day: "numeric" })).toBe("-");
    expect(formatDateTimeOrDash("not-a-date", { day: "numeric" })).toBe("-");
  });
});
