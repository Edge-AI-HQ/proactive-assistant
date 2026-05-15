import { afterEach, describe, expect, test } from "vitest";

import {
  clearSelectedAmbientSummaryModelId,
  getSelectedAmbientSummaryModelId,
  setSelectedAmbientSummaryModelId,
} from "./models-selection";

describe("ambient model selection", () => {
  afterEach(() => {
    localStorage.clear();
  });

  test("does not select a model by default", () => {
    expect(getSelectedAmbientSummaryModelId()).toBeNull();
  });

  test("persists only an explicit local summaries model selection", () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");

    expect(getSelectedAmbientSummaryModelId()).toBe("qwen3-1_7b-q4");

    clearSelectedAmbientSummaryModelId();
    expect(getSelectedAmbientSummaryModelId()).toBeNull();
  });
});
