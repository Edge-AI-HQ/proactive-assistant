import test from "node:test";
import assert from "node:assert/strict";

import { resolveIncomingChatMessage } from "./chat.ts";

test("cardContext only falls back to injected first message", () => {
  assert.equal(
    resolveIncomingChatMessage({
      message: undefined,
      firstMessage: 'The user opened "Quiet Hours". Suggested action: "Enable quiet hours". Confirm details briefly, then execute.',
    }),
    'The user opened "Quiet Hours". Suggested action: "Enable quiet hours". Confirm details briefly, then execute.',
  );
});

test("user message wins when message and cardContext arrive together", () => {
  assert.equal(
    resolveIncomingChatMessage({
      message: "确认，到时候我需要做什么",
      firstMessage: 'The user opened "Quiet Hours". Suggested action: "Enable quiet hours". Confirm details briefly, then execute.',
    }),
    "确认，到时候我需要做什么",
  );
});
