import { describe, expect, test } from "vitest";

import { reasoningStepLabel, sourceAppMeta } from "./source-app";

describe("sourceAppMeta", () => {
  test("品牌 slug → brand + label(无 iconKey)", () => {
    expect(sourceAppMeta("gmail")).toEqual({ brand: "gmail", label: "Gmail" });
    expect(sourceAppMeta("gcal")).toEqual({ brand: "gcal", label: "Calendar" });
  });

  test("内部层 slug → iconKey + label(brand null)", () => {
    expect(sourceAppMeta("web")).toEqual({ brand: null, label: "Web", iconKey: "web" });
    expect(sourceAppMeta("device")).toEqual({ brand: null, label: "Phone", iconKey: "device" });
  });

  test("未知 slug → 首字母大写 chip", () => {
    expect(sourceAppMeta("brex")).toEqual({ brand: null, label: "Brex" });
  });
});

describe("reasoningStepLabel", () => {
  test("已知枚举 → 展示文案", () => {
    expect(reasoningStepLabel("observed")).toBe("Observed");
    expect(reasoningStepLabel("cross_referenced")).toBe("Cross-referenced");
  });

  test("未知 → prettify", () => {
    expect(reasoningStepLabel("looked_up")).toBe("Looked up");
  });
});
