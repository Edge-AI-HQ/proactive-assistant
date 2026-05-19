import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { isCompletedCardOutcome, isHiddenCardOutcome, useCards } from "./useCards";

vi.mock("@/lib/api", () => ({
  proxyFetch: vi.fn(async () =>
    new Response(
      JSON.stringify({
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
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ),
}));

import { proxyFetch } from "@/lib/api";

describe("useCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("parses latest card outcome from /cards", async () => {
    const { result } = renderHook(() => useCards());

    await waitFor(() => {
      expect(result.current.cards).toHaveLength(1);
    });

    expect(proxyFetch).toHaveBeenCalledWith("/cards?limit=200", {
      signal: expect.any(AbortSignal),
    });
    expect(result.current.cards[0]?.latestOutcome).toBe("complete");
    expect(result.current.cards[0]?.outcomeAt).toBe("2026-05-18T09:05:00+00:00");
    expect(isCompletedCardOutcome(result.current.cards[0]?.latestOutcome)).toBe(true);
    expect(isHiddenCardOutcome(result.current.cards[0]?.latestOutcome)).toBe(true);
  });
});
