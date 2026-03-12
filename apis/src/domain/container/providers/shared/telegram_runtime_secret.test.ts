import assert from "node:assert/strict";
import test from "node:test";
import {
  QUICKSTART_SYNTHETIC_BOT_TOKEN,
  deriveAssistantWebhookSecret,
} from "./telegram_runtime_secret.js";

test("QUICKSTART_SYNTHETIC_BOT_TOKEN starts with 0: prefix", () => {
  assert.ok(QUICKSTART_SYNTHETIC_BOT_TOKEN.startsWith("0:"));
});

test("deriveAssistantWebhookSecret is deterministic", () => {
  const s1 = deriveAssistantWebhookSecret(42, "gw-token", "api-token");
  const s2 = deriveAssistantWebhookSecret(42, "gw-token", "api-token");
  assert.equal(s1, s2);
});

test("deriveAssistantWebhookSecret returns hex string", () => {
  const s = deriveAssistantWebhookSecret(42, "gw-token", "api-token");
  assert.match(s, /^[0-9a-f]{64}$/);
});

test("deriveAssistantWebhookSecret: different gateway tokens produce different secrets", () => {
  const s1 = deriveAssistantWebhookSecret(42, "gw-token-a", "api-token");
  const s2 = deriveAssistantWebhookSecret(42, "gw-token-b", "api-token");
  assert.notEqual(s1, s2);
});

test("deriveAssistantWebhookSecret: fallback salt when apiToken is null", () => {
  const s = deriveAssistantWebhookSecret(42, "gw-token", null);
  assert.match(s, /^[0-9a-f]{64}$/);
  // Different from when apiToken is provided
  const sWithApi = deriveAssistantWebhookSecret(42, "gw-token", "api-token");
  assert.notEqual(s, sWithApi);
});
