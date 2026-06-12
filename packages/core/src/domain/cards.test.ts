// 等价迁移自旧 hooks/useCards.test.ts 的纯函数部分（hook 部分由
// state 包的 TQ 实现 + app 薄壳覆盖）。
import { describe, expect, test } from "vitest";

import {
  isCompletedCardOutcome,
  isHiddenCardOutcome,
  parseEntries,
} from "./cards";

const livePayload = {
  cards: [
    {
      card: {
        id: "card_1",
        goalBasket: "work",
        title: "OpenAI ticket follow-up",
        whyNow: "The customer is waiting.",
        summary: "Draft the reply.",
        primaryAction: { label: "Draft a reply", type: "confirm" },
        sources: ["gmail msg_1"],
      },
      runId: "run_1",
      runCompletedAt: "2026-05-18T09:01:00+00:00",
      score: { overall: 7, pass: true },
      latestOutcome: "complete",
      outcomeAt: "2026-05-18T09:05:00+00:00",
    },
    // 缺 runId 的行被丢弃
    { card: { id: "card_2" }, runCompletedAt: "2026-05-18T09:01:00+00:00" },
  ],
};

describe("parseEntries", () => {
  test("normalizes valid rows and drops malformed ones", () => {
    const entries = parseEntries(livePayload);
    expect(entries).toHaveLength(1);
    expect(entries[0].card.id).toBe("card_1");
    expect(entries[0].card.title).toBe("OpenAI ticket follow-up");
    expect(entries[0].score).toEqual({ overall: 7, pass: true });
    expect(entries[0].latestOutcome).toBe("complete");
  });

  test("returns [] for non-object / missing cards payloads", () => {
    expect(parseEntries(null)).toEqual([]);
    expect(parseEntries({})).toEqual([]);
    expect(parseEntries({ cards: "nope" })).toEqual([]);
  });

  test("unknown outcome strings parse to null", () => {
    const entries = parseEntries({
      cards: [{ ...livePayload.cards[0], latestOutcome: "exploded" }],
    });
    expect(entries[0].latestOutcome).toBeNull();
  });

  test("runStatus parses the pai_agent_runs enum; absent/unknown → null", () => {
    const entries = parseEntries({
      cards: [
        { ...livePayload.cards[0], runStatus: "awaiting_input" },
        { ...livePayload.cards[0], card: { id: "card_3" }, runStatus: "done" },
        { ...livePayload.cards[0], card: { id: "card_4" } },
      ],
    });
    expect(entries[0].runStatus).toBe("awaiting_input");
    expect(entries[1].runStatus).toBeNull();
    expect(entries[2].runStatus).toBeNull();
  });
});

describe("outcome helpers", () => {
  test("complete is completed and hidden; dismiss/snooze hidden only", () => {
    expect(isCompletedCardOutcome("complete")).toBe(true);
    expect(isCompletedCardOutcome("dismiss")).toBe(false);
    expect(isHiddenCardOutcome("complete")).toBe(true);
    expect(isHiddenCardOutcome("dismiss")).toBe(true);
    expect(isHiddenCardOutcome("snooze")).toBe(true);
    expect(isHiddenCardOutcome("confirm")).toBe(false);
    expect(isHiddenCardOutcome(null)).toBe(false);
  });
});
