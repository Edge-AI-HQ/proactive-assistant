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
    expect(prompt).toContain("pin personal mobile items list --type contact_directory_snapshot --order desc --limit 1 --json");
    expect(prompt).toContain("pin personal mobile items list --type app_inventory_snapshot --order desc --limit 1 --json");
  });

  it("forces a personal-data-first collection flow before planning", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
    });

    expect(prompt).toContain("Start with personal data before planning");
    expect(prompt).toContain("pin personal connections list --json");
    expect(prompt).toContain("pin personal tools search --query");
    expect(prompt).toContain("pin personal tools schema --name");
    expect(prompt).toContain("pin personal exec --tool");
    expect(prompt).toContain("If personal connections exist, do not leave `personalData` empty");
    expect(prompt).toContain("record the failure inside `collectedContext.personalData.gaps`");
    expect(prompt).toContain('"mobileSnapshots": {');
    expect(prompt).toContain('"contacts": { ... }');
    expect(prompt).toContain('"apps": { ... }');
  });

  it("treats sustained card-chat engagement as a strong follow-up signal", () => {
    const prompt = buildPlannerPrompt({
      currentDate: "2026-04-07",
      iterationNumber: 1,
    });

    expect(prompt).toContain("sustained card-chat engagement");
    expect(prompt).toContain("do not simply repeat the same card");
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
