import { describe, expect, it } from "vitest";

import { buildPlannerPrompt } from "./planner.js";

describe("buildPlannerPrompt", () => {
  it("uses a context brief instead of instructing the planner to gather context itself", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      contextBrief: JSON.stringify({
        profileStatus: { exists: true, goalsCount: 2 },
        personalStatus: { connectedApps: ["gmail"] },
        worldStatus: { shortlistCount: 3 },
      }, null, 2),
      previousIterationDelta: JSON.stringify({
        failedObjectives: ["Make the why-now more specific"],
      }, null, 2),
    });

    expect(prompt).toContain("## Context Brief");
    expect(prompt).toContain("## Previous Iteration Delta");
    expect(prompt).not.toContain("### Step 1: Gather Context");
    expect(prompt).not.toContain("Use pin CLI to load the user's current state");
    expect(prompt).toContain("\"evidenceRefs\": [");
    expect(prompt).toContain("\"contextGaps\": [");
  });

  it("injects recent feedback signals as a dedicated section", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      contextBrief: JSON.stringify({ profileStatus: { exists: true } }),
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
      contextBrief: JSON.stringify({ profileStatus: { exists: false } }),
    });

    expect(prompt).not.toContain("## Recent User Feedback Signals");
  });
});
