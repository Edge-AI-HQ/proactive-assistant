import { describe, expect, it } from "vitest";

import { buildGeneratorPrompt } from "./generator.js";

describe("buildGeneratorPrompt", () => {
  it("injects recent feedback signals as a dedicated section", () => {
    const prompt = buildGeneratorPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      plan: JSON.stringify({ intentsToGenerate: [] }),
      recentFeedbackSummary: "- Frequently modified: health cards (1)\n- Recent preferences: Prefer concise health nudges",
      recentGeneratedCardsSummary: "- health: adjust-evening-walk-plan | 2026-04-06 | Adjust evening walk plan",
    });

    expect(prompt).toContain("## Recent User Feedback Signals");
    expect(prompt).toContain("Frequently modified: health cards (1)");
    expect(prompt).toContain("Prefer concise health nudges");
    expect(prompt).toContain("## Recent Generated Card History");
    expect(prompt).toContain("pin cards recent --limit 10 --json");
    expect(prompt).toContain("adjust-evening-walk-plan");
  });

  it("does not add empty feedback or generated-card sections", () => {
    const prompt = buildGeneratorPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      plan: JSON.stringify({ intentsToGenerate: [] }),
    });

    expect(prompt).not.toContain("## Recent User Feedback Signals");
    expect(prompt).not.toContain("## Recent Generated Card History");
  });
});
