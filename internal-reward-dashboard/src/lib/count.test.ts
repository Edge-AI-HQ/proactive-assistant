import { describe, expect, it } from "vitest";
import {
  finiteCount,
  formatCount,
  pageWithinOffsetLimit,
  pageWithinTotal,
  totalPagesFor,
  totalPagesForOffsetLimit,
} from "./count";

describe("count formatting", () => {
  it("normalizes unsafe totals before display", () => {
    expect(finiteCount(12.8)).toBe(12);
    expect(finiteCount(-3)).toBe(0);
    expect(finiteCount(Number.NaN, 7)).toBe(7);
    expect(finiteCount(Number.POSITIVE_INFINITY, 7)).toBe(7);
  });

  it("formats only finite non-negative counts", () => {
    expect(formatCount(1200)).toBe("1,200");
    expect(formatCount(Number.NaN)).toBe("0");
  });

  it("keeps pagination totals finite", () => {
    expect(totalPagesFor(81, 40)).toBe(3);
    expect(totalPagesFor(Number.NaN, 40)).toBe(1);
    expect(totalPagesFor(80, 0)).toBe(80);
  });

  it("keeps requested pages inside the loaded total", () => {
    expect(pageWithinTotal(3, 81, 40)).toBe(3);
    expect(pageWithinTotal(4, 81, 40)).toBe(3);
    expect(pageWithinTotal(0, 81, 40)).toBe(1);
    expect(pageWithinTotal(2, 0, 40)).toBe(1);
  });

  it("keeps pagination inside backend offset limits", () => {
    expect(totalPagesForOffsetLimit(1_000, 40, 120)).toBe(4);
    expect(totalPagesForOffsetLimit(80, 40, 120)).toBe(2);
    expect(pageWithinOffsetLimit(5, 1_000, 40, 120)).toBe(4);
    expect(pageWithinOffsetLimit(0, 1_000, 40, 120)).toBe(1);
  });
});
