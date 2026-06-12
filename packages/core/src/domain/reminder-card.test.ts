import { describe, expect, it } from "vitest";

import { isReminderCard } from "./reminder-card";

describe("isReminderCard", () => {
  it("detects the explicit cardKind stamped at creation", () => {
    expect(isReminderCard({ id: "anything", cardKind: "reminder" })).toBe(true);
  });

  it("falls back to the card-rem- id prefix for older persisted cards", () => {
    expect(isReminderCard({ id: "card-rem-a4bbf49040c6" })).toBe(true);
  });

  it("rejects generator and connector cards", () => {
    expect(isReminderCard({ id: "gen.auto.1.34beeda5_card_00" })).toBe(false);
    expect(isReminderCard({ id: "gen.x_card_01", cardKind: "" })).toBe(false);
  });
});
