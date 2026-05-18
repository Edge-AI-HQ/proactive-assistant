import { afterEach, describe, expect, test } from "vitest";

import {
  clearSelectedAmbientAsrModelId,
  clearSelectedAmbientSummaryModelId,
  getSelectedAmbientAsrModelId,
  getSelectedAmbientSummaryModelId,
  setSelectedAmbientAsrModelId,
  setSelectedAmbientSummaryModelId,
} from "./models-selection";

describe("ambient model selection", () => {
  afterEach(() => {
    localStorage.clear();
  });

  test("does not select a summary model by default", () => {
    expect(getSelectedAmbientSummaryModelId()).toBeNull();
  });

  test("persists only an explicit local summaries model selection", () => {
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");

    expect(getSelectedAmbientSummaryModelId()).toBe("qwen3-1_7b-q4");

    clearSelectedAmbientSummaryModelId();
    expect(getSelectedAmbientSummaryModelId()).toBeNull();
  });

  test("does not select an ASR model by default", () => {
    expect(getSelectedAmbientAsrModelId()).toBeNull();
  });

  test("persists only an explicit ASR model selection", () => {
    setSelectedAmbientAsrModelId("whisper-base");

    expect(getSelectedAmbientAsrModelId()).toBe("whisper-base");

    clearSelectedAmbientAsrModelId();
    expect(getSelectedAmbientAsrModelId()).toBeNull();
  });

  test("ASR and summary selections are independent", () => {
    setSelectedAmbientAsrModelId("whisper-base");
    setSelectedAmbientSummaryModelId("qwen3-1_7b-q4");

    expect(getSelectedAmbientAsrModelId()).toBe("whisper-base");
    expect(getSelectedAmbientSummaryModelId()).toBe("qwen3-1_7b-q4");

    clearSelectedAmbientAsrModelId();
    expect(getSelectedAmbientAsrModelId()).toBeNull();
    expect(getSelectedAmbientSummaryModelId()).toBe("qwen3-1_7b-q4");
  });
});
