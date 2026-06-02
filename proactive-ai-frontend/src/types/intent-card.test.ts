import { describe, expect, test } from "vitest";

import { normalizeIntentCard } from "./intent-card";

describe("normalizeIntentCard", () => {
  test("preserves backend intentKey for feedback fanout", () => {
    expect(
      normalizeIntentCard({
        id: "card-1",
        intentKey: "work:review-pr",
        goalBasket: "work",
        title: "Review PR",
        whyNow: "Waiting for review",
        primaryAction: { label: "Review", type: "confirm" },
      }).intentKey,
    ).toBe("work:review-pr");
  });
});
