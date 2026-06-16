import { describe, expect, test } from "vitest";

import { reasoningStepKey, reasoningStepLabel, sourceAppMeta } from "./source-app";

describe("sourceAppMeta", () => {
  test("品牌 slug:纯品牌词无 labelKey;有中立词的品牌(gcal)给 labelKey", () => {
    expect(sourceAppMeta("gmail")).toEqual({ brand: "gmail", label: "Gmail" });
    expect(sourceAppMeta("gcal")).toEqual({ brand: "gcal", label: "Calendar", labelKey: "calendar" });
  });

  test("内部层 slug → iconKey + labelKey + label(brand null)", () => {
    expect(sourceAppMeta("web")).toEqual({ brand: null, label: "Web", iconKey: "web", labelKey: "web" });
    expect(sourceAppMeta("device")).toEqual({ brand: null, label: "Phone", iconKey: "device", labelKey: "phone" });
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

describe("reasoningStepKey", () => {
  test("已知枚举 → camelCase i18n 键", () => {
    expect(reasoningStepKey("observed")).toBe("observed");
    expect(reasoningStepKey("cross_referenced")).toBe("crossReferenced");
  });

  test("未知 → null", () => {
    expect(reasoningStepKey("looked_up")).toBeNull();
  });
});
