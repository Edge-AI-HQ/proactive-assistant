import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOnboardingGreetingPrompt,
  chooseProfileCandidate,
  normalizeLegacyMysqlUrl,
  shouldTriggerReadyGreeting,
} from "./profile_bootstrap.js";

test("normalizeLegacyMysqlUrl converts mysql+pymysql scheme", () => {
  assert.equal(
    normalizeLegacyMysqlUrl("mysql+pymysql://user:pass@host:3306/db"),
    "mysql://user:pass@host:3306/db",
  );
});

test("chooseProfileCandidate prioritizes connector mapping", () => {
  const selected = chooseProfileCandidate({
    connector: {
      profileText: "connector profile",
      source: "connector",
      externalUserId: 11,
      profileUpdatedAt: "2026-01-01T00:00:00Z",
      accountCreatedAt: "2024-01-01T00:00:00Z",
    },
    privy: {
      profileText: "privy profile",
      source: "privy",
      externalUserId: 22,
      profileUpdatedAt: "2026-02-01T00:00:00Z",
      accountCreatedAt: "2025-02-01T00:00:00Z",
    },
  });

  assert.equal(selected?.source, "connector");
  assert.equal(selected?.profileText, "connector profile");
});

test("chooseProfileCandidate falls back to privy mapping", () => {
  const selected = chooseProfileCandidate({
    connector: null,
    privy: {
      profileText: "privy profile",
      source: "privy",
      externalUserId: 22,
      profileUpdatedAt: null,
      accountCreatedAt: null,
    },
  });

  assert.equal(selected?.source, "privy");
  assert.equal(selected?.profileText, "privy profile");
});

test("shouldTriggerReadyGreeting is false after first successful trigger", () => {
  assert.equal(shouldTriggerReadyGreeting({}), true);
  assert.equal(shouldTriggerReadyGreeting({ onboarding_greeted_at: "2026-03-06T08:00:00Z" }), false);
});

test("buildOnboardingGreetingPrompt includes pinai tenure identity and style constraints", () => {
  const prompt = buildOnboardingGreetingPrompt({
    hasProfile: true,
    profileText: "Daily syncs and gaming as SmileToYe",
    membershipDays: 800,
    membershipSinceDate: "2023-12-28",
  });

  assert.match(prompt, /valued PINAI member/i);
  assert.match(prompt, /about 800 days/i);
  assert.match(prompt, /since 2023-12-28/i);
  assert.match(prompt, /How can I help you today\?/);
  assert.match(prompt, /preferred name \+ response style/i);
  assert.match(prompt, /playful|fun|light humor/i);
  assert.match(prompt, /max 2 short paragraphs/i);
  assert.match(prompt, /1-2 natural emoji/i);
});
