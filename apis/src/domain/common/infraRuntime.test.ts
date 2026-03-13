import test from "node:test";
import assert from "node:assert/strict";

import { executeAssistantReadyNotificationsForTest } from "./infraRuntime.js";

test("executeAssistantReadyNotificationsForTest sends fixed then PIN Claw greeting when lock is claimed", async () => {
  const calls: string[] = [];
  await executeAssistantReadyNotificationsForTest({
    assistantId: 9,
    telegramUserId: 1001,
    claimReadyNotifyLock: async () => true,
    sendFixedReadyMessage: async () => {
      calls.push("fixed");
    },
    sendHiPinReadyGreeting: async () => {
      calls.push("pinclaw");
      return true;
    },
  });

  assert.deepEqual(calls, ["fixed", "pinclaw"]);
});

test("executeAssistantReadyNotificationsForTest skips sends when lock is not claimed", async () => {
  const calls: string[] = [];
  await executeAssistantReadyNotificationsForTest({
    assistantId: 9,
    telegramUserId: 1001,
    claimReadyNotifyLock: async () => false,
    sendFixedReadyMessage: async () => {
      calls.push("fixed");
    },
    sendHiPinReadyGreeting: async () => {
      calls.push("pinclaw");
      return true;
    },
  });

  assert.deepEqual(calls, []);
});

test("executeAssistantReadyNotificationsForTest sends only fixed when no assistant id", async () => {
  const calls: string[] = [];
  await executeAssistantReadyNotificationsForTest({
    assistantId: null,
    telegramUserId: 1001,
    claimReadyNotifyLock: async () => true,
    sendFixedReadyMessage: async () => {
      calls.push("fixed");
    },
    sendHiPinReadyGreeting: async () => {
      calls.push("pinclaw");
      return true;
    },
  });

  assert.deepEqual(calls, ["fixed"]);
});

test("executeAssistantReadyNotificationsForTest swallows fixed-message error when no assistant id", async () => {
  await executeAssistantReadyNotificationsForTest({
    assistantId: null,
    telegramUserId: 1001,
    claimReadyNotifyLock: async () => true,
    sendFixedReadyMessage: async () => {
      throw new Error("boom");
    },
    sendHiPinReadyGreeting: async () => true,
  });
});
