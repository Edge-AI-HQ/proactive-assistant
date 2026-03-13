import test from "node:test";
import assert from "node:assert/strict";

import {
  buildApiReadyGreetingMessage,
  buildReadyGreetingFallbackMessage,
  computeDaysWithPinaiForTest,
  pickEarlierIsoDateForTest,
  resolveReadyGreetingLocaleForTest,
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
  assert.match(message, /online and ready to help/i);
  assert.match(message, /✨ How can I help you today\?/i);
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
  assert.match(message, /online and ready to help/i);
  assert.match(message, /How can I help you today/i);
});
