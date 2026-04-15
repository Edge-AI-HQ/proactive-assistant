import test from "node:test";
import assert from "node:assert/strict";

import { runAutoCardChatFeedback } from "./auto-loop.ts";

test("runAutoCardChatFeedback syncs when pipeline is idle", async () => {
  const calls: string[] = [];

  await runAutoCardChatFeedback(
    { logger: { error: () => undefined } } as never,
    { running: false, phase: null, iteration: null },
    {
      syncCardChatFeedback: async () => {
        calls.push("sync");
      },
    },
  );

  assert.deepEqual(calls, ["sync"]);
});

test("runAutoCardChatFeedback skips sync while pipeline is running", async () => {
  let called = false;

  await runAutoCardChatFeedback(
    { logger: { error: () => undefined } } as never,
    { running: true, phase: "manual", iteration: 1 },
    {
      syncCardChatFeedback: async () => {
        called = true;
      },
    },
  );

  assert.equal(called, false);
});
