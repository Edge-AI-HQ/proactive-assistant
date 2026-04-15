import test from "node:test";
import assert from "node:assert/strict";

import { loadRecentGeneratedCardsSummary } from "./generated-cards-summary.ts";

test("loadRecentGeneratedCardsSummary formats recent generated cards for prompts", async () => {
  const summary = await loadRecentGeneratedCardsSummary(
    { limit: 10, since: "14d" },
    {
      listRecentGeneratedCards: async () => [
        {
          goalBasket: "work",
          titleKey: "review-queue-with-alex",
          title: "Review queue with Alex",
          generatedAt: "2026-04-07T10:00:00.000Z",
        },
        {
          goalBasket: "health",
          titleKey: "adjust-evening-walk-plan",
          title: "Adjust evening walk plan",
          generatedAt: "2026-04-06T10:00:00.000Z",
        },
      ],
    },
  );

  assert.equal(
    summary,
    "- work: review-queue-with-alex | 2026-04-07 | Review queue with Alex\n- health: adjust-evening-walk-plan | 2026-04-06 | Adjust evening walk plan",
  );
});
