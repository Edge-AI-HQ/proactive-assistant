import { describe, expect, it } from "vitest";

import { intentCardToIntent, intentCardsToIntents } from "./cardAdapter";
import type { IntentCard } from "@/types/intent-card";

const baseCard: IntentCard = {
  id: "card-abc123",
  goalBasket: "work",
  title: "Reply to Alex",
  whyNow: "Alex sent a follow-up earlier today.",
  summary: "Outstanding invoice from March needs reply.",
  primaryAction: { label: "Draft a reply", type: "confirm" },
  secondaryActions: [],
  confidence: 0.92,
  urgency: 0.9,
  importance: 0.85,
  sources: ["Gmail", "Google Calendar"],
  agentChain: ["card-gen"],
  createdAt: "2026-05-14T00:00:00Z",
};

describe("intentCardToIntent", () => {
  it("maps core fields and produces stable numeric id", () => {
    const a = intentCardToIntent(baseCard, { status: "normal" });
    const b = intentCardToIntent(baseCard, { status: "normal" });
    expect(a.id).toEqual(b.id);
    expect(typeof a.id).toBe("number");
    expect(a.id).toBeGreaterThanOrEqual(0);
    expect(a.originalId).toBe("card-abc123");
    expect(a.title).toBe("Reply to Alex");
    expect(a.line1).toBe("Alex sent a follow-up earlier today.");
    expect(a.line2).toBe("Sources: Gmail · Google Calendar");
    expect(a.category).toBe("work");
  });

  it("marks urgent when urgency >= 0.85", () => {
    expect(intentCardToIntent(baseCard, { status: "normal" }).tag).toBe("Urgent");
    const calm = { ...baseCard, urgency: 0.5 };
    expect(intentCardToIntent(calm, { status: "normal" }).tag).toBeUndefined();
  });

  it("maps wealth → finance, family → life for visual category", () => {
    expect(
      intentCardToIntent({ ...baseCard, goalBasket: "wealth" }, { status: "normal" }).category,
    ).toBe("finance");
    expect(
      intentCardToIntent({ ...baseCard, goalBasket: "family" }, { status: "normal" }).category,
    ).toBe("life");
  });

  it("falls back to summary when whyNow is empty", () => {
    const noWhy = { ...baseCard, whyNow: "" };
    expect(intentCardToIntent(noWhy, { status: "normal" }).line1).toBe(noWhy.summary);
  });

  it("emits empty line2 when no sources", () => {
    const noSrc = { ...baseCard, sources: [] };
    expect(intentCardToIntent(noSrc, { status: "normal" }).line2).toBe("");
  });

  it("builds detail with rounded scores and primary action as willExecute", () => {
    const it1 = intentCardToIntent(baseCard, { status: "normal" });
    expect(it1.detail).toBeDefined();
    expect(it1.detail!.scores).toEqual([
      { label: "Confidence", value: 92 },
      { label: "Importance", value: 85 },
      { label: "Urgency", value: 90 },
    ]);
    expect(it1.detail!.willExecute).toBe("Draft a reply");
    expect(it1.detail!.dataSources).toEqual(["Gmail", "Google Calendar"]);
    expect(it1.detail!.executionPlan).toEqual([]);
    expect(it1.detail!.impact).toBe("");
    expect(it1.detail!.permissions).toBe("");
  });

  it("respects status override", () => {
    expect(intentCardToIntent(baseCard, { status: "processing" }).status).toBe("processing");
    expect(intentCardToIntent(baseCard, { status: "done" }).status).toBe("done");
  });
});

describe("intentCardsToIntents", () => {
  it("returns empty array when input is empty", () => {
    expect(
      intentCardsToIntents([], { processingIds: new Set(), doneIds: new Set() }),
    ).toEqual([]);
  });

  it("applies status from processingIds / doneIds maps", () => {
    const cards: IntentCard[] = [
      { ...baseCard, id: "p1" },
      { ...baseCard, id: "d1" },
      { ...baseCard, id: "n1" },
    ];
    const out = intentCardsToIntents(cards, {
      processingIds: new Set(["p1"]),
      doneIds: new Set(["d1"]),
    });
    expect(out.map((i) => i.status)).toEqual(["processing", "done", "normal"]);
  });
});
