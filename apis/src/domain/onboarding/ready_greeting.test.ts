import test from "node:test";
import assert from "node:assert/strict";

import {
  buildApiReadyGreetingMessage,
  buildReadyGreetingFallbackMessage,
  computeDaysWithPinaiForTest,
  pickEarlierIsoDateForTest,
  resolveReadyGreetingLocaleForTest,
  resolveMySqlJoinDateForTest,
  shouldSendApiReadyGreetingForTest,
} from "./ready_greeting.js";

test("buildApiReadyGreetingMessage renders simplified English greeting", () => {
  const message = buildApiReadyGreetingMessage({
    locale: "en",
    subscriptionActive: true,
    joinDate: "2025-02-27T00:00:00.000Z",
    daysWithPinai: 373,
    askPreferredName: true,
  });

  assert.match(message, /👋/);
  assert.match(message, /PIN Claw/i);
  assert.match(message, /Thanks for staying with PINAI/i);
  assert.match(message, /You've been with PINAI since/i);
  assert.match(message, /✨ What would you like to work on first\?/i);
});

test("buildApiReadyGreetingMessage renders subscribed Chinese greeting", () => {
  const message = buildApiReadyGreetingMessage({
    locale: "zh",
    subscriptionActive: true,
    joinDate: "2025-02-27T00:00:00.000Z",
    daysWithPinai: 373,
    askPreferredName: true,
  });

  assert.match(message, /👋/);
  assert.match(message, /感谢你一直陪伴 PINAI/);
  assert.match(message, /✨ 今天想先处理什么/);
});

test("resolveReadyGreetingLocaleForTest defaults to English and maps zh locales", () => {
  assert.equal(resolveReadyGreetingLocaleForTest(undefined), "en");
  assert.equal(resolveReadyGreetingLocaleForTest("zh-CN"), "zh");
  assert.equal(resolveReadyGreetingLocaleForTest("en-US"), "en");
});

test("computeDaysWithPinaiForTest returns null for invalid date and positive days for valid date", () => {
  assert.equal(computeDaysWithPinaiForTest("bad-date"), null);
  const days = computeDaysWithPinaiForTest("2025-02-27T00:00:00.000Z");
  assert.equal(typeof days, "number");
  assert.ok((days ?? 0) >= 1);
});

test("pickEarlierIsoDateForTest supports Date-like values", () => {
  const picked = pickEarlierIsoDateForTest(
    new Date("2024-01-01T00:00:00.000Z"),
    "2025-01-01T00:00:00.000Z",
  );
  assert.equal(picked, "2024-01-01T00:00:00.000Z");
});

test("buildReadyGreetingFallbackMessage returns simplified greeting", () => {
  const message = buildReadyGreetingFallbackMessage();
  assert.match(message, /PIN Claw/i);
  assert.match(message, /Welcome back to PINAI/i);
  assert.match(message, /What would you like to work on first/i);
});

test("resolveMySqlJoinDateForTest uses MySQL accountCreatedAt only", () => {
  assert.equal(resolveMySqlJoinDateForTest(null), null);
  assert.equal(
    resolveMySqlJoinDateForTest({
      source: "connector",
      externalUserId: 11,
      profileText: "x",
      profileUpdatedAt: null,
      accountCreatedAt: "2024-01-01T00:00:00.000Z",
    }),
    "2024-01-01T00:00:00.000Z",
  );
  assert.equal(
    resolveMySqlJoinDateForTest({
      source: "privy",
      externalUserId: 22,
      profileText: "x",
      profileUpdatedAt: null,
      accountCreatedAt: null,
    }),
    null,
  );
});

test("shouldSendApiReadyGreetingForTest requires MySQL join date", () => {
  assert.equal(shouldSendApiReadyGreetingForTest({ joinDate: null }), false);
  assert.equal(
    shouldSendApiReadyGreetingForTest({
      joinDate: "2024-01-01T00:00:00.000Z",
    }),
    true,
  );
});
