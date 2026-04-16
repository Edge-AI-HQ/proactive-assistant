import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handlePersonal } from "./personal.ts";
import { ingestMobileItems, resetMobileDbForTests } from "../mobile-db.ts";

function withTempHome(fn: () => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-cli-"));
    process.env.OPENCLAW_HOME = home;
    resetMobileDbForTests();
    try {
      await fn();
    } finally {
      resetMobileDbForTests();
      if (previous === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previous;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

test("handlePersonal mobile items list returns pending rows", withTempHome(async () => {
  await ingestMobileItems({
    deviceId: "pixel-1",
    items: [
      {
        id: "item-1",
        itemType: "session_summary",
        title: "Session summary",
        summary: "Discussed travel plans.",
        payload: { sessionId: "session-1" },
        salience: 0.9,
        confidence: 0.8,
        dedupeKey: "session:session-1",
        occurredAt: "2026-04-16T08:00:00.000Z",
        availableAt: "2026-04-16T08:00:00.000Z",
        expiresAt: "2026-04-17T08:00:00.000Z",
      },
    ],
  });

  const result = JSON.parse(await handlePersonal(["mobile", "items", "list", "--status", "pending"]));
  assert.equal(result.ok, true);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].id, "item-1");
}));

test("handlePersonal mobile claim + commit updates item status", withTempHome(async () => {
  await ingestMobileItems({
    deviceId: "pixel-2",
    items: [
      {
        id: "item-claim",
        itemType: "attention_item",
        title: "Follow up",
        summary: "Need a same-day follow-up.",
        payload: { source: "notification" },
        salience: 0.6,
        confidence: 0.8,
        dedupeKey: "attention:follow-up",
        occurredAt: "2026-04-16T09:00:00.000Z",
        availableAt: "2026-04-16T09:00:00.000Z",
        expiresAt: "2026-04-17T09:00:00.000Z",
      },
    ],
  });

  const claimed = JSON.parse(await handlePersonal(["mobile", "items", "claim", "--limit", "1"]));
  assert.equal(claimed.ok, true);
  assert.equal(claimed.data.items.length, 1);

  const committed = JSON.parse(await handlePersonal(["mobile", "items", "commit", "--run-token", claimed.data.runToken]));
  assert.equal(committed.ok, true);
  assert.equal(committed.data.processed, 1);

  const listed = JSON.parse(await handlePersonal(["mobile", "items", "list", "--status", "processed"]));
  assert.equal(listed.ok, true);
  assert.equal(listed.data.items.length, 1);
  assert.equal(listed.data.items[0].id, "item-claim");
}));
