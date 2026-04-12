import { describe, expect, it } from "vitest";

import { normalizeTitleKey } from "./service.js";

describe("normalizeTitleKey", () => {
  it("preserves unicode letters and numbers instead of collapsing Chinese titles", () => {
    expect(normalizeTitleKey("买房首付规划")).toBe("买房首付规划");
    expect(normalizeTitleKey("  季度 OKR 复盘  ")).toBe("季度-okr-复盘");
  });

  it("falls back to a stable untitled key when no slug-safe characters remain", () => {
    const key = normalizeTitleKey("!!!");

    expect(key).toMatch(/^untitled-[a-z0-9]+$/);
    expect(normalizeTitleKey("!!!")).toBe(key);
  });
});
