import { describe, expect, it } from "vitest";

import { buildPlannerPrompt } from "./planner.js";

describe("buildPlannerPrompt", () => {
  it("injects recent feedback signals as a dedicated section", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      recentFeedbackSummary: "- Frequently confirmed: work cards (2)\n- Recent preferences: Prefer morning work briefings",
    });

    expect(prompt).toContain("## Recent User Feedback Signals");
    expect(prompt).toContain("Frequently confirmed: work cards (2)");
    expect(prompt).toContain("Prefer morning work briefings");
  });

  it("does not add an empty recent feedback section", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
    });

    expect(prompt).not.toContain("## Recent User Feedback Signals");
  });
});
