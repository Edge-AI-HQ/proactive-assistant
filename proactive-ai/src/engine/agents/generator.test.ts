import { describe, expect, it } from "vitest";

import { buildGeneratorPrompt } from "./generator.js";

describe("buildGeneratorPrompt", () => {
  it("uses evidence packs instead of asking the generator to do open-ended tool discovery", () => {
    const prompt = buildGeneratorPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      plan: JSON.stringify({
        intentsToGenerate: [{ goalBasket: "work", objective: "Follow up on the review" }],
      }),
      evidencePacks: JSON.stringify([
        {
          objective: "Follow up on the review",
          evidenceRefs: ["profile.goals", "incremental.personal"],
          facts: [{ source: "incremental.personal", value: "Review tomorrow at 10am" }],
        },
      ], null, 2),
    });

    expect(prompt).toContain("## Evidence Packs");
    expect(prompt).toContain("Use ONLY the provided evidence packs");
    expect(prompt).not.toContain("pin personal tools search");
    expect(prompt).not.toContain("pin personal tools schema");
    expect(prompt).not.toContain("Deep Data Gathering");
  });

  it("injects recent feedback signals as a dedicated section", () => {
    const prompt = buildGeneratorPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      plan: JSON.stringify({ intentsToGenerate: [] }),
      evidencePacks: JSON.stringify([]),
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
      evidencePacks: JSON.stringify([]),
    });

    expect(prompt).not.toContain("## Recent User Feedback Signals");
  });
});
