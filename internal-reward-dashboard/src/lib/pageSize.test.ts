import { describe, expect, it } from "vitest";
import { normalizePageSize } from "./pageSize";

describe("normalizePageSize", () => {
  it("keeps allowed page sizes", () => {
    expect(normalizePageSize(40, [20, 40, 80], 20)).toBe(40);
  });

  it("falls back for invalid page sizes", () => {
    expect(normalizePageSize(0, [20, 40, 80], 20)).toBe(20);
    expect(normalizePageSize(41, [20, 40, 80], 20)).toBe(20);
    expect(normalizePageSize(Number.NaN, [20, 40, 80], 20)).toBe(20);
  });
});
