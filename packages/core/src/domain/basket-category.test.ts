import { describe, expect, test } from "vitest";

import { basketCategory } from "./basket-category";

describe("basketCategory", () => {
  test("同义词收敛到同一类目 + label", () => {
    expect(basketCategory("work")).toEqual({ iconKey: "work", label: "Work" });
    expect(basketCategory("career")).toEqual({ iconKey: "work", label: "Work" });
    expect(basketCategory("financial")).toEqual({ iconKey: "finance", label: "Finance" });
  });

  test("大小写归一", () => {
    expect(basketCategory("HEALTH").iconKey).toBe("health");
  });

  test("精确不中时取连字符前缀", () => {
    expect(basketCategory("work-life-balance").iconKey).toBe("work");
  });

  test("未知 key → fallback general", () => {
    expect(basketCategory("nope")).toEqual({ iconKey: "general", label: "General" });
  });
});
