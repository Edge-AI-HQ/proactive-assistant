import { describe, expect, it } from "vitest";
import { buildPlannerPrompt } from "../../agents/planner";
import { buildGeneratorPrompt } from "../../agents/generator";
import { buildEvaluatorPrompt } from "../../agents/evaluator";

describe("generation language prompt injection", () => {
  it("uses the selected language in planner and generator prompts", () => {
    const plannerPrompt = buildPlannerPrompt({
      currentDate: "2026-04-08",
      iterationNumber: 1,
      outputLanguage: "ja",
    });
    const generatorPrompt = buildGeneratorPrompt({
      currentDate: "2026-04-08",
      iterationNumber: 1,
      plan: "{}",
      outputLanguage: "de",
    });

    expect(plannerPrompt).toContain("MUST be written in Japanese");
    expect(generatorPrompt).toContain("MUST be written in German");
    expect(plannerPrompt).not.toContain("Simplified Chinese (简体中文)");
    expect(generatorPrompt).not.toContain("Simplified Chinese (简体中文)");
  });

  it("uses the selected language in evaluator prompts", () => {
    const evaluatorPrompt = buildEvaluatorPrompt({
      currentDate: "2026-04-08",
      iterationNumber: 1,
      maxIterations: 2,
      plan: "{}",
      cards: "{}",
      outputLanguage: "zh-Hans",
    });

    expect(evaluatorPrompt).toContain("MUST be written in Simplified Chinese");
    expect(evaluatorPrompt).toContain("JSON keys, schema field names, enums, URLs, IDs, and raw source titles can remain");
  });
});
