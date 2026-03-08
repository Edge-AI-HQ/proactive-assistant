import test from "node:test";
import assert from "node:assert/strict";

import { buildReadyGreetingWebhookUrlsForTest } from "./ready_greeting.js";

test("buildReadyGreetingWebhookUrlsForTest sends onboarding trigger only to private webhook", () => {
  assert.deepEqual(buildReadyGreetingWebhookUrlsForTest("https://pinclaw-api-dev.fly.dev"), [
    "https://pinclaw-api-dev.fly.dev/webhook/telegram/private",
  ]);
});
