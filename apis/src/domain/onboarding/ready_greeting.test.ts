import test from "node:test";
import assert from "node:assert/strict";

import {
  buildApiReadyGreetingMessage,
  buildReadyGreetingFallbackMessage,
  computeDaysWithPinaiForTest,
  resolveReadyGreetingLocaleForTest,
} from "./ready_greeting.js";

test("buildApiReadyGreetingMessage renders subscribed English greeting with friendly formatting", () => {
  const message = buildApiReadyGreetingMessage({
    locale: "en",
    subscriptionActive: true,
    joinDate: "2025-02-27T00:00:00.000Z",
    daysWithPinai: 373,
    askPreferredName: true,
  });

  assert.match(message, /👋/);
  assert.match(message, /💎 Hi,/i);
  assert.match(message, /373 days/i);
  assert.match(message, /Feb 27, 2025/i);
  assert.match(message, /Quick check before we start:/i);
  assert.match(message, /• What should I call you\?/i);
  assert.match(message, /✨ How can I help you today\?/i);
});

test("buildApiReadyGreetingMessage renders subscribed Chinese greeting with tenure wording", () => {
  const message = buildApiReadyGreetingMessage({
    locale: "zh",
    subscriptionActive: true,
    joinDate: "2025-02-27T00:00:00.000Z",
    daysWithPinai: 373,
    askPreferredName: true,
  });

  assert.match(message, /👋/);
  assert.match(message, /感谢你一直陪伴 PINAI/);
  assert.match(message, /373 天/);
  assert.match(message, /2025-02-27/);
  assert.match(message, /• 我该怎么称呼你/);
  assert.match(message, /✨ 今天想先处理什么/);
});

test("buildApiReadyGreetingMessage uses neutral wording when subscription is inactive", () => {
  const message = buildApiReadyGreetingMessage({
    locale: "en",
    subscriptionActive: false,
    joinDate: "2025-02-27T00:00:00.000Z",
    daysWithPinai: 373,
    askPreferredName: true,
  });

  assert.doesNotMatch(message, /HiPin/i);
  assert.match(message, /Welcome back/i);
});

test("buildApiReadyGreetingMessage degrades safely without join date", () => {
  const message = buildApiReadyGreetingMessage({
    locale: "en",
    subscriptionActive: true,
    joinDate: null,
    daysWithPinai: null,
    askPreferredName: true,
  });

  assert.match(message, /Hi,/i);
  assert.doesNotMatch(message, /days together/i);
});

test("buildApiReadyGreetingMessage uses singular day for one day tenure", () => {
  const message = buildApiReadyGreetingMessage({
    locale: "en",
    subscriptionActive: true,
    joinDate: "2025-02-27T00:00:00.000Z",
    daysWithPinai: 1,
    askPreferredName: true,
  });

  assert.match(message, /1 day together/i);
  assert.doesNotMatch(message, /1 days together/i);
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

test("buildReadyGreetingFallbackMessage stays deterministic", () => {
  assert.equal(
    buildReadyGreetingFallbackMessage(),
    [
      "👋 Hey, I’m online now.",
      "",
      "💎 Welcome back, and thanks for being with PINAI.",
      "",
      "Quick check before we start:",
      "• What should I call you?",
      "• Do you want me to be concise or detailed?",
      "",
      "✨ How can I help you today?",
    ].join("\n"),
  );
});
