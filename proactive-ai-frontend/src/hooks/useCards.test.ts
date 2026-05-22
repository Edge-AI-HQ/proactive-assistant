import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  proxyFetch: vi.fn(),
}));

import {
  cardsCacheKey,
  isCompletedCardOutcome,
  isHiddenCardOutcome,
  parseEntries,
  readCachedCards,
  writeCardsCache,
} from "./useCards";

const liveCardsPayload = {
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
  ],
};

function installSessionStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

describe("useCards helpers", () => {
  beforeEach(() => {
    installSessionStorage();
  });

  test("parses latest card outcome from /cards", () => {
    const cards = parseEntries(liveCardsPayload);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.latestOutcome).toBe("complete");
    expect(cards[0]?.outcomeAt).toBe("2026-05-18T09:05:00+00:00");
    expect(isCompletedCardOutcome(cards[0]?.latestOutcome)).toBe(true);
    expect(isHiddenCardOutcome(cards[0]?.latestOutcome)).toBe(true);
  });

  test("hydrates cached cards from sessionStorage", () => {
    writeCardsCache(200, "user-1", liveCardsPayload);

    const cards = readCachedCards(200, "user-1");

    expect(cards?.[0]?.card.id).toBe("card_1");
    expect(globalThis.sessionStorage.getItem(cardsCacheKey(200, "user-1"))).toContain("card_1");
    expect(readCachedCards(200, "user-2")).toBeNull();
  });
});
