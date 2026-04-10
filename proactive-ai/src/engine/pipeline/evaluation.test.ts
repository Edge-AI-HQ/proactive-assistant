import { describe, expect, it } from "vitest";

import {
  mapWithConcurrency,
  runRuleValidators,
} from "./evaluation.js";

describe("runRuleValidators", () => {
  it("flags missing sources, weak why-now signals, and duplicate titles", () => {
    const cards = [
      {
        id: "card_1",
        goalBasket: "work",
        title: "Prepare the board review",
        whyNow: "Soon",
        summary: "Need to get ready.",
        primaryAction: { label: "Do it", type: "confirm" },
        secondaryActions: [{ label: "Modify", type: "modify" }],
        confidence: 0.8,
        urgency: 0.7,
        importance: 0.9,
        sources: [],
        agentChain: ["planner", "generator"],
        createdAt: "2026-04-09T00:00:00.000Z",
      },
      {
        id: "card_2",
        goalBasket: "work",
        title: "Prepare the board review",
        whyNow: "Board review is tomorrow at 10am",
        summary: "The review starts tomorrow morning.",
        primaryAction: { label: "Draft the briefing", type: "confirm" },
        secondaryActions: [{ label: "Modify", type: "modify" }],
        confidence: 0.8,
        urgency: 0.7,
        importance: 0.9,
        sources: ["profile.goals"],
        agentChain: ["planner", "generator"],
        createdAt: "2026-04-09T00:00:00.000Z",
      },
    ];

    const validators = runRuleValidators(cards as never, {
      "card_1": { objective: "Prepare the board review", evidenceRefs: ["profile.goals"], facts: [] },
      "card_2": { objective: "Prepare the board review", evidenceRefs: ["profile.goals"], facts: [] },
    });

    expect(validators["card_1"]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "sources.missing" }),
      expect.objectContaining({ code: "why_now.weak" }),
      expect.objectContaining({ code: "card.duplicate_title" }),
    ]));
    expect(validators["card_2"]?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "card.duplicate_title" }),
    ]));
  });
});

describe("mapWithConcurrency", () => {
  it("honors the configured concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});
