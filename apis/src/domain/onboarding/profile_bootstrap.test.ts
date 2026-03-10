import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseProfileCandidate,
  normalizeLegacyMysqlUrl,
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


