import { describe, expect, test } from "vitest";
import type { ProfileSnapshot } from "@pin-ai/core";
import { profileSummaryText } from "./mirror";

type ProfileRecord = NonNullable<ProfileSnapshot["profile"]>;

function profileWith(overrides: Partial<ProfileRecord>): ProfileRecord {
  return {
    id: "profile-1",
    user_id: "local-user",
    display_name: "Smile",
    locale: "en",
    timezone: "UTC",
    summary: null,
    facts: {},
    preferences: {},
    constraints: {},
    metadata: {},
    ...overrides,
  };
}

describe("profileSummaryText", () => {
  test("uses an identity-like field when the summary is empty", () => {
    const text = profileSummaryText(
      profileWith({ facts: { identify: "Builds personal AI products and tests mobile flows." } }),
    );
    expect(text).toBe("Builds personal AI products and tests mobile flows.");
  });

  test("does not borrow unrelated profile fields — falls back instead", () => {
    const fallback = profileSummaryText(null);
    const text = profileSummaryText(
      profileWith({ facts: { role: "founder" }, preferences: { communication: "direct" } }),
    );
    expect(text).toBe(fallback);
    expect(text).not.toContain("founder");
    expect(text).not.toContain("direct");
  });
});
