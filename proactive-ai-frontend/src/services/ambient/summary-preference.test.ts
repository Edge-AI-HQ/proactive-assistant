import { beforeEach, describe, expect, test } from "vitest";

import {
  AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY,
  effectiveAmbientSummaryMode,
  loadAmbientSummaryPreference,
  saveAmbientSummaryPreference,
  type AmbientSummaryPreference,
} from "./summary-preference";

describe("ambient summary preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("defaults to cloud summaries when uploads are unlocked", () => {
    expect(loadAmbientSummaryPreference()).toBe("cloud_when_unlocked");
    expect(effectiveAmbientSummaryMode({ uploadsLocked: false })).toBe("cloud_llm");
  });

  test("forces local summaries while uploads are locked", () => {
    saveAmbientSummaryPreference("cloud_when_unlocked");

    expect(effectiveAmbientSummaryMode({ uploadsLocked: true })).toBe("local_llm");
  });

  test("persists local-only preference on this device", () => {
    saveAmbientSummaryPreference("local_only");

    expect(localStorage.getItem(AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY)).toBe("local_only");
    expect(loadAmbientSummaryPreference()).toBe("local_only");
    expect(effectiveAmbientSummaryMode({ uploadsLocked: false })).toBe("local_llm");
  });

  test("ignores invalid stored preference", () => {
    localStorage.setItem(
      AMBIENT_SUMMARY_PREFERENCE_STORAGE_KEY,
      "always_cloud" satisfies Exclude<string, AmbientSummaryPreference>,
    );

    expect(loadAmbientSummaryPreference()).toBe("cloud_when_unlocked");
  });
});
