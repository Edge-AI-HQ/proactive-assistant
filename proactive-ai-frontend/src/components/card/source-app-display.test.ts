import { describe, expect, test } from "vitest";

import { reasoningStepLabel, sourceAppDisplay } from "./source-app-display";

describe("sourceAppDisplay", () => {
  test("known brand slugs map to brand + label", () => {
    expect(sourceAppDisplay("gmail")).toMatchObject({ brand: "gmail", label: "Gmail" });
    expect(sourceAppDisplay("gcal")).toMatchObject({ brand: "gcal", label: "Calendar" });
  });

  test("internal layers map to mono icon + label", () => {
    expect(sourceAppDisplay("web").label).toBe("Web");
    expect(sourceAppDisplay("web").brand).toBeNull();
    expect(sourceAppDisplay("web").Icon).toBeDefined();
    expect(sourceAppDisplay("device").label).toBe("Phone");
    expect(sourceAppDisplay("memory").label).toBe("Memory");
  });

  test("unknown slug falls back to capitalized first-letter chip", () => {
    expect(sourceAppDisplay("brex")).toEqual({ brand: null, label: "Brex" });
  });
});

describe("reasoningStepLabel", () => {
  test("maps known enum labels to display text", () => {
    expect(reasoningStepLabel("observed")).toBe("Observed");
    expect(reasoningStepLabel("cross_referenced")).toBe("Cross-referenced");
    expect(reasoningStepLabel("pattern_matched")).toBe("Pattern matched");
  });

  test("falls back to prettified unknown label", () => {
    expect(reasoningStepLabel("looked_up")).toBe("Looked up");
  });
});
