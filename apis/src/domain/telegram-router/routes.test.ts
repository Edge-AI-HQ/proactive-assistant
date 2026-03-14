import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTelegramOutboundMessage,
  isBudgetExceededMessage,
  resetTelegramWelcomeDedupeForTest,
  shouldSuppressTelegramOutboundMessage,
} from "./routes.js";

test("router module does not expose Google OAuth prompt helpers", async () => {
  const mod = await import("./routes.js");
  assert.equal("buildGoogleOAuthPrompt" in mod, false);
  assert.equal("buildGoogleCalendarReauthPromptForTest" in mod, false);
  assert.equal("buildGoogleCredentialSyncingPromptForTest" in mod, false);
  assert.equal("hasGoogleWorkspaceIntentForTest" in mod, false);
  assert.equal("hasAnyScopeForTest" in mod, false);
  assert.equal("shouldPromptGoogleOAuthForTest" in mod, false);
  assert.equal("shouldSuppressGoogleOAuthPromptForTest" in mod, false);
  assert.equal("detectPromptLanguage" in mod, false);
});

test("classifyTelegramOutboundMessage marks welcome messages only", () => {
  assert.equal(
    classifyTelegramOutboundMessage("Welcome back. What should I call you? How can I help you today?"),
    "welcome",
  );
  assert.equal(classifyTelegramOutboundMessage("Here are your latest 10 emails"), null);
});

test("shouldSuppressTelegramOutboundMessage dedupes repeated welcome sendMessage calls", () => {
  resetTelegramWelcomeDedupeForTest();

  const first = shouldSuppressTelegramOutboundMessage(
    "sendMessage",
    {
      chatId: 6142814327,
      contentType: "application/json",
      text: "Welcome back. What should I call you? How can I help you today?",
    },
    1_000,
  );
  const second = shouldSuppressTelegramOutboundMessage(
    "sendMessage",
    {
      chatId: 6142814327,
      contentType: "application/json",
      text: "Good to see you again. How can I help you today?",
    },
    2_000,
  );

  assert.equal(first, false);
  assert.equal(second, true);
});

test("shouldSuppressTelegramOutboundMessage does not suppress normal business replies", () => {
  resetTelegramWelcomeDedupeForTest();

  const suppressed = shouldSuppressTelegramOutboundMessage(
    "sendMessage",
    {
      chatId: 6142814327,
      contentType: "application/json",
      text: "Here are your latest 10 emails.",
    },
    1_000,
  );

  assert.equal(suppressed, false);
});

test("shouldSuppressTelegramOutboundMessage ignores sendMessageDraft", () => {
  resetTelegramWelcomeDedupeForTest();

  const suppressed = shouldSuppressTelegramOutboundMessage(
    "sendMessageDraft",
    {
      chatId: 6142814327,
      contentType: "application/json",
      text: "Welcome back. What should I call you?",
    },
    1_000,
  );

  assert.equal(suppressed, false);
});

test("isBudgetExceededMessage matches LiteLLM budget exceeded error", () => {
  assert.equal(
    isBudgetExceededMessage("400 Budget has been exceeded! Current cost: 32.186020299999996, Max budget: 32.0"),
    true,
  );
});

test("isBudgetExceededMessage matches variations", () => {
  assert.equal(isBudgetExceededMessage("Budget has been exceeded"), true);
  assert.equal(isBudgetExceededMessage("Error: exceeded budget limit"), true);
  assert.equal(isBudgetExceededMessage("insufficient budget remaining"), true);
});

test("isBudgetExceededMessage does not match normal messages", () => {
  assert.equal(isBudgetExceededMessage("Here are your latest 10 emails"), false);
  assert.equal(isBudgetExceededMessage("What is your budget for this project?"), false);
  assert.equal(isBudgetExceededMessage(undefined), false);
  assert.equal(isBudgetExceededMessage(""), false);
});
