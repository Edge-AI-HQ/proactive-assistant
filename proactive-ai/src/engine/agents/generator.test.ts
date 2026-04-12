import { describe, expect, it } from "vitest";

import { buildGeneratorPrompt } from "./generator.js";

describe("buildGeneratorPrompt", () => {
  it("injects recent feedback signals as a dedicated section", () => {
    const prompt = buildGeneratorPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      plan: JSON.stringify({ intentsToGenerate: [] }),
      recentFeedbackSummary: "- Frequently modified: health cards (1)\n- Recent preferences: Prefer concise health nudges",
    });

    expect(prompt).toContain("## Recent User Feedback Signals");
    expect(prompt).toContain("Frequently modified: health cards (1)");
    expect(prompt).toContain("Prefer concise health nudges");
  });

  it("does not add an empty recent feedback section", () => {
    const prompt = buildGeneratorPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      plan: JSON.stringify({ intentsToGenerate: [] }),
    });

    expect(prompt).not.toContain("## Recent User Feedback Signals");
  });

  it("injects memory context when incremental context is provided", () => {
    const prompt = buildGeneratorPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      plan: JSON.stringify({ intentsToGenerate: [] }),
      incrementalContext: JSON.stringify({
        memory: {
          residentMemories: [{ text: "User prefers short, execution-ready work recommendations." }],
          relevantMemories: [{ text: "User recently dismissed travel cards as not relevant." }],
        },
      }, null, 2),
    });

    expect(prompt).toContain("## Incremental And Memory Context");
    expect(prompt).toContain("execution-ready work recommendations");
    expect(prompt).toContain("dismissed travel cards");
  });
});
