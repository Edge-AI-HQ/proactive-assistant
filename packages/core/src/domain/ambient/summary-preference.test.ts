import { describe, expect, test } from "vitest";

import {
  DEFAULT_AMBIENT_SUMMARY_PREFERENCE,
  effectiveAmbientSummaryMode,
  normalizeAmbientSummaryPreference,
} from "./summary-preference";

describe("normalizeAmbientSummaryPreference", () => {
  test("accepts the two known values", () => {
    expect(normalizeAmbientSummaryPreference("local_only")).toBe("local_only");
    expect(normalizeAmbientSummaryPreference("cloud_when_unlocked")).toBe("cloud_when_unlocked");
  });

  test("falls back to the default for unknown / missing values", () => {
    expect(normalizeAmbientSummaryPreference(null)).toBe(DEFAULT_AMBIENT_SUMMARY_PREFERENCE);
    expect(normalizeAmbientSummaryPreference(undefined)).toBe(DEFAULT_AMBIENT_SUMMARY_PREFERENCE);
    expect(normalizeAmbientSummaryPreference("bogus")).toBe(DEFAULT_AMBIENT_SUMMARY_PREFERENCE);
  });
});

describe("effectiveAmbientSummaryMode", () => {
  test("uploadsLocked forces local regardless of preference", () => {
    expect(effectiveAmbientSummaryMode({ uploadsLocked: true })).toBe("local_llm");
    expect(effectiveAmbientSummaryMode({ uploadsLocked: true, preference: "cloud_when_unlocked" }))
      .toBe("local_llm");
  });

  test("unlocked follows preference, defaulting to cloud", () => {
    expect(effectiveAmbientSummaryMode({ uploadsLocked: false })).toBe("cloud_llm");
    expect(effectiveAmbientSummaryMode({ uploadsLocked: false, preference: "cloud_when_unlocked" }))
      .toBe("cloud_llm");
    expect(effectiveAmbientSummaryMode({ uploadsLocked: false, preference: "local_only" }))
      .toBe("local_llm");
  });
});
