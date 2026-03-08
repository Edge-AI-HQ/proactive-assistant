import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGoogleCredentialSyncingPromptForTest,
  buildGoogleOAuthPrompt,
  classifyTelegramOutboundMessage,
  detectPromptLanguage,
  hasGoogleWorkspaceIntentForTest,
  shouldPromptGoogleOAuthForTest,
  resetTelegramWelcomeDedupeForTest,
  shouldSuppressGoogleOAuthPromptForTest,
  shouldSuppressTelegramOutboundMessage,
} from "./routes.js";

test("detectPromptLanguage uses Chinese when the user asks in Chinese", () => {
  assert.equal(detectPromptLanguage("给我最新的10封邮件"), "zh");
});

test("detectPromptLanguage defaults to English for non-Chinese requests", () => {
  assert.equal(detectPromptLanguage("Show me my latest 10 emails"), "en");
});

test("buildGoogleOAuthPrompt returns Chinese mini app guidance without raw URL", () => {
  const prompt = buildGoogleOAuthPrompt("给我最新的10封邮件");
  assert.match(prompt, /左下角/);
  assert.match(prompt, /Manage -> Connect Google/);
  assert.doesNotMatch(prompt, /https?:\/\//);
});

test("buildGoogleOAuthPrompt returns English mini app guidance without raw URL", () => {
  const prompt = buildGoogleOAuthPrompt("Show me my latest 10 emails");
  assert.match(prompt, /bottom-left button in Telegram/);
  assert.match(prompt, /Manage -> Connect Google/);
  assert.doesNotMatch(prompt, /https?:\/\//);
});

test("buildGoogleCredentialSyncingPromptForTest returns Chinese syncing hint", () => {
  const prompt = buildGoogleCredentialSyncingPromptForTest("我下一个日历是什么");
  assert.match(prompt, /正在同步凭证/);
  assert.match(prompt, /10-20 秒/);
});

test("buildGoogleCredentialSyncingPromptForTest returns English syncing hint", () => {
  const prompt = buildGoogleCredentialSyncingPromptForTest("Show my next calendar event");
  assert.match(prompt, /Google is connected/);
  assert.match(prompt, /10-20 seconds/);
});

test("hasGoogleWorkspaceIntentForTest matches calendar and drive requests", () => {
  assert.equal(hasGoogleWorkspaceIntentForTest("我下一个日历是什么"), true);
  assert.equal(hasGoogleWorkspaceIntentForTest("Show my next calendar event"), true);
  assert.equal(hasGoogleWorkspaceIntentForTest("帮我看一下 Google Drive 里的文件"), true);
  assert.equal(hasGoogleWorkspaceIntentForTest("What is the weather today?"), false);
});

test("shouldPromptGoogleOAuthForTest ignores private onboarding triggers", () => {
  assert.equal(shouldPromptGoogleOAuthForTest("private", "Show me my latest 10 emails"), false);
  assert.equal(shouldPromptGoogleOAuthForTest("public", "Show me my latest 10 emails"), true);
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

test("shouldSuppressGoogleOAuthPromptForTest dedupes same prompt in short window", () => {
  resetTelegramWelcomeDedupeForTest();

  const first = shouldSuppressGoogleOAuthPromptForTest(
    6142814327,
    "我下一个日历是什么",
    1_000,
  );
  const second = shouldSuppressGoogleOAuthPromptForTest(
    6142814327,
    "我下一个日历是什么",
    5_000,
  );

  assert.equal(first, false);
  assert.equal(second, true);
});

test("shouldSuppressGoogleOAuthPromptForTest allows resend after dedupe window", () => {
  resetTelegramWelcomeDedupeForTest();

  shouldSuppressGoogleOAuthPromptForTest(6142814327, "Show my next calendar event", 1_000);
  const later = shouldSuppressGoogleOAuthPromptForTest(
    6142814327,
    "Show my next calendar event",
    30_000,
  );

  assert.equal(later, false);
});
