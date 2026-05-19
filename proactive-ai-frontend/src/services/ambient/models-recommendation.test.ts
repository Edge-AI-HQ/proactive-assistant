import { describe, expect, test } from "vitest";

import {
  RECOMMENDED_AMBIENT_LLM_MODEL_ID,
  isRecommendedAmbientLlmModel,
} from "./models-recommendation";

describe("ambient model recommendation", () => {
  test("recommends Gemma 2B for Ambient LLM summaries", () => {
    expect(RECOMMENDED_AMBIENT_LLM_MODEL_ID).toBe("gemma-2-2b-q4");
    expect(isRecommendedAmbientLlmModel("gemma-2-2b-q4")).toBe(true);
    expect(isRecommendedAmbientLlmModel("qwen3-1_7b-q4")).toBe(false);
  });
});
