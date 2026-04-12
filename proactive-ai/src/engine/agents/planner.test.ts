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

  it("includes concrete pin CLI commands and schema fallback for nested lookups", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
    });

    expect(prompt).toContain("pin push history --since 14d --json");
    expect(prompt).toContain("pin world shortlist --profile-id default --limit 10 --json");
    expect(prompt).toContain("pin profile interests list --id default --kind topic --limit 20 --json");
    expect(prompt).toContain("pin profile snapshot build --id default --view ranking --json");
    expect(prompt).toContain("pin profile facts get --json");
    expect(prompt).toContain("pin sys schema push.history --json");
  });

  it("treats sustained card-chat engagement as a strong follow-up signal", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
    });

    expect(prompt).toContain("sustained card-chat engagement");
    expect(prompt).toContain("do not simply repeat the same card");
  });
});
