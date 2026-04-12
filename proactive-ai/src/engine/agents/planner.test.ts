import { describe, expect, it } from "vitest";

import { buildPlannerPrompt } from "./planner.js";

describe("buildPlannerPrompt", () => {
  it("injects recent feedback signals as a dedicated section", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      recentFeedbackSummary: "- Frequently confirmed: work cards (2)\n- Recent preferences: Prefer morning work briefings",
      recentGeneratedCardsSummary: "- work: review-queue-with-alex | 2026-04-07 | Review queue with Alex",
    });

    expect(prompt).toContain("## Recent User Feedback Signals");
    expect(prompt).toContain("Frequently confirmed: work cards (2)");
    expect(prompt).toContain("Prefer morning work briefings");
    expect(prompt).toContain("## Recent Generated Card History");
    expect(prompt).toContain("pin cards recent --limit 10 --json");
    expect(prompt).toContain("review-queue-with-alex");
  });

  it("does not add empty feedback or generated-card sections", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
    });

    expect(prompt).not.toContain("## Recent User Feedback Signals");
    expect(prompt).not.toContain("## Recent Generated Card History");
  });

  it("does not require a free-form reasoning field in planner json output", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
    });

    expect(prompt).not.toContain('"reasoning":');
    expect(prompt).toContain('If you need quotation marks inside string values, use Chinese quotes like 「」 or escape ASCII quotes as \\".');
  });

  it("injects memory context when incremental context is provided", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
      incrementalContext: JSON.stringify({
        memory: {
          residentMemories: [{ text: "User is actively working on Supabase issue triage." }],
          relevantMemories: [{ text: "User confirmed repo maintenance cards twice this week." }],
        },
      }, null, 2),
    });

    expect(prompt).toContain("## Incremental And Memory Context");
    expect(prompt).toContain("Supabase issue triage");
    expect(prompt).toContain("repo maintenance cards twice this week");
  });
});
