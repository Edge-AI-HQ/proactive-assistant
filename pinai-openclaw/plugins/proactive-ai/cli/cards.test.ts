import test from "node:test";
import assert from "node:assert/strict";

import { handleCards } from "./cards.ts";

test("handleCards recent returns recent generated cards", async () => {
  const output = await handleCards(
    ["recent", "--limit", "2"],
    {
      listRecentGeneratedCards: async () => [
        { cardId: "card-1", goalBasket: "work", title: "Review queue with Alex" },
        { cardId: "card-2", goalBasket: "health", title: "Adjust evening walk plan" },
      ],
    },
  );

  const parsed = JSON.parse(output) as { ok: boolean; data: { count: number; records: Array<{ cardId: string }> } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.count, 2);
  assert.deepEqual(parsed.data.records.map((item) => item.cardId), ["card-1", "card-2"]);
});
