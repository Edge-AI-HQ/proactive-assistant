import { describe, expect, test } from "vitest";

import { weatherMeta } from "./weather";

describe("weatherMeta", () => {
  test("WMO code → label + 语义 iconKey", () => {
    expect(weatherMeta(0)).toEqual({ label: "Clear", iconKey: "sun" });
    expect(weatherMeta(3)).toEqual({ label: "Cloudy", iconKey: "cloud" });
    expect(weatherMeta(45)).toEqual({ label: "Foggy", iconKey: "fog" });
    expect(weatherMeta(65)).toEqual({ label: "Rainy", iconKey: "rain" });
    expect(weatherMeta(75)).toEqual({ label: "Snowy", iconKey: "snow" });
    expect(weatherMeta(95)).toEqual({ label: "Stormy", iconKey: "lightning" });
  });

  test("showers 与 rainy 共用 rain 图标键、label 不同", () => {
    expect(weatherMeta(82)).toEqual({ label: "Showers", iconKey: "rain" });
  });

  test("区间外 code 回退 cloudy", () => {
    expect(weatherMeta(88)).toEqual({ label: "Cloudy", iconKey: "cloud" });
  });
});
