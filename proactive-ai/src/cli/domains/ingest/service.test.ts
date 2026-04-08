import test from "node:test";
import assert from "node:assert/strict";

import type { CliRuntimeInput } from "../../runtime.js";
import { runIngest } from "./service.js";

const runtime: CliRuntimeInput = {
  env: {},
  homeDir: "/Users/test",
};

test("runIngest reports inserted counts instead of fetched counts", async () => {
  let insertCalls = 0;
  const result = await runIngest(
    runtime,
    { domains: "world,personal" },
    {
      loadStore: async () => ({
        worldCursorUpdatedAt: null,
        personalSnapshotHash: null,
      }),
      fetchWorldHeadlines: async () => undefined,
      fetchWorldItems: async () => ([
        {
          id: "w1",
          title: "Markets rally",
          provider: "google-news",
          updatedAt: "2026-04-08T09:00:00.000Z",
        },
      ]),
      fetchPersonalStatus: async () => ({ configured: true }),
      fetchPersonalConnections: async () => ([
        { toolkit: "gmail", status: "ACTIVE", connectedAccountId: "acct_1" },
      ]),
      enqueuePending: async () => {
        insertCalls += 1;
        return {
          insertedCount: 2,
          insertedBySource: { world: 1, personal: 1 },
          pendingCount: 2,
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.ok, true);
  assert.equal(insertCalls, 1);
  assert.deepEqual(result.stdout.data, {
    inserted: {
      world: 1,
      personal: 1,
      total: 2,
    },
    pending: 2,
  });
});
