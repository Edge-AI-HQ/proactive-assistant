import test from "node:test";
import assert from "node:assert/strict";

import type { PinEnvelope } from "../../output/envelope.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import { runPersonalFeedE2E } from "./e2e.js";

const ok = <T>(command: string, data: T): PinEnvelope<T> => ({
  ok: true,
  data,
  meta: {
    domain: "personal",
    command,
    requestId: "req_test",
    timestamp: "2026-04-02T00:00:00.000Z",
  },
  error: null,
  _notice: null,
});

test("runPersonalFeedE2E executes sync search and index chain for gmail", async () => {
  const calls: string[][] = [];
  const runtime: CliRuntimeInput = {
    env: {
      PIN_DATA_ROOT: "/tmp/pin-personal-e2e",
      COMPOSIO_API_KEY: "test-composio-key",
      OPENAI_API_KEY: "test-openai-key",
    },
    homeDir: "/Users/test",
  };

  const result = await runPersonalFeedE2E(runtime, {
    runCommand: async (argv) => {
      calls.push(argv);

      const command = argv.slice(0, 3).join(" ");
      if (command === "personal sync run") {
        return {
          exitCode: 0,
          stdout: ok("sync run", {
            mode: "incremental",
            sourcesDiscovered: 1,
            sourcesSynced: 1,
            itemsFetched: 10,
            itemsUpserted: 10,
          }),
        };
      }

      if (command === "personal source list") {
        return {
          exitCode: 0,
          stdout: ok("source list", [
            {
              id: "src_gmail_main",
              userId: "user_123",
              toolkit: "gmail",
              status: "ACTIVE",
              syncEnabled: true,
              syncSupported: true,
            },
          ]),
        };
      }

      if (command === "personal timeline --from") {
        return {
          exitCode: 0,
          stdout: ok("timeline", [
            {
              id: "src_gmail_main:email:msg_1",
              toolkit: "gmail",
              title: "Career update",
              snippet: "Research direction update",
            },
          ]),
        };
      }

      if (command === "personal item get") {
        return {
          exitCode: 0,
          stdout: ok("item get", {
            id: "src_gmail_main:email:msg_1",
            title: "Career update",
            contentText: "Research direction update",
          }),
        };
      }

      if (command === "personal index refresh") {
        return {
          exitCode: 0,
          stdout: ok("index refresh", {
            mode: "all",
            itemsSelected: 10,
            itemsIndexed: 10,
            deletedCount: 0,
            model: "text-embedding-3-small",
          }),
        };
      }

      if (
        argv[0] === "personal" &&
        argv[1] === "search" &&
        argv.includes("--strategy") &&
        argv.includes("semantic")
      ) {
        return {
          exitCode: 0,
          stdout: ok("search", {
            strategy: "semantic",
            degraded: false,
            results: [
              {
                id: "src_gmail_main:email:msg_1",
                matchReason: "semantic",
              },
            ],
          }),
        };
      }

      if (
        argv[0] === "personal" &&
        argv[1] === "search" &&
        argv.includes("--strategy") &&
        argv.includes("hybrid")
      ) {
        return {
          exitCode: 0,
          stdout: ok("search", {
            strategy: "hybrid",
            degraded: false,
            results: [
              {
                id: "src_gmail_main:email:msg_1",
                matchReason: "hybrid",
              },
            ],
          }),
        };
      }

      throw new Error(`Unexpected argv: ${argv.join(" ")}`);
    },
  });

  assert.equal(result.toolkit, "gmail");
  assert.equal(result.query, "Career update");
  assert.equal(result.sourceCount, 1);
  assert.equal(result.timelineCount, 1);
  assert.equal(result.indexedCount, 10);
  assert.equal(result.semanticResultCount, 1);
  assert.equal(result.hybridResultCount, 1);
  assert.equal(result.sampleItemId, "src_gmail_main:email:msg_1");

  assert.deepEqual(
    calls.map((argv) => argv.slice(0, 3)),
    [
      ["personal", "sync", "run"],
      ["personal", "source", "list"],
      ["personal", "timeline", "--from"],
      ["personal", "item", "get"],
      ["personal", "index", "refresh"],
      ["personal", "search", "--query"],
      ["personal", "search", "--query"],
    ],
  );
});

test("runPersonalFeedE2E accepts semantic results that do not include the sampled item", async () => {
  const runtime: CliRuntimeInput = {
    env: {
      PIN_DATA_ROOT: "/tmp/pin-personal-e2e",
      COMPOSIO_API_KEY: "test-composio-key",
      OPENAI_API_KEY: "test-openai-key",
    },
    homeDir: "/Users/test",
  };

  const result = await runPersonalFeedE2E(runtime, {
    runCommand: async (argv) => {
      const command = argv.slice(0, 3).join(" ");
      if (command === "personal sync run") {
        return {
          exitCode: 0,
          stdout: ok("sync run", {
            mode: "incremental",
            sourcesDiscovered: 1,
            sourcesSynced: 1,
            itemsFetched: 10,
            itemsUpserted: 10,
          }),
        };
      }

      if (command === "personal source list") {
        return {
          exitCode: 0,
          stdout: ok("source list", [
            {
              id: "src_gmail_main",
              userId: "user_123",
              toolkit: "gmail",
              status: "ACTIVE",
              syncEnabled: true,
              syncSupported: true,
            },
          ]),
        };
      }

      if (command === "personal timeline --from") {
        return {
          exitCode: 0,
          stdout: ok("timeline", [
            {
              id: "src_gmail_main:email:msg_1",
              toolkit: "gmail",
              title: "Career update",
              snippet: "Research direction update",
            },
          ]),
        };
      }

      if (command === "personal item get") {
        return {
          exitCode: 0,
          stdout: ok("item get", {
            id: "src_gmail_main:email:msg_1",
            title: "Career update",
            contentText: "Research direction update",
          }),
        };
      }

      if (command === "personal index refresh") {
        return {
          exitCode: 0,
          stdout: ok("index refresh", {
            mode: "all",
            itemsSelected: 10,
            itemsIndexed: 10,
            deletedCount: 0,
            model: "text-embedding-3-small",
          }),
        };
      }

      if (
        argv[0] === "personal" &&
        argv[1] === "search" &&
        argv.includes("--strategy") &&
        argv.includes("semantic")
      ) {
        return {
          exitCode: 0,
          stdout: ok("search", {
            strategy: "semantic",
            degraded: false,
            results: [
              {
                id: "src_gmail_main:email:msg_other",
                matchReason: "semantic",
              },
            ],
          }),
        };
      }

      if (
        argv[0] === "personal" &&
        argv[1] === "search" &&
        argv.includes("--strategy") &&
        argv.includes("hybrid")
      ) {
        return {
          exitCode: 0,
          stdout: ok("search", {
            strategy: "hybrid",
            degraded: false,
            results: [
              {
                id: "src_gmail_main:email:msg_1",
                matchReason: "hybrid",
              },
            ],
          }),
        };
      }

      throw new Error(`Unexpected argv: ${argv.join(" ")}`);
    },
  });

  assert.equal(result.semanticResultCount, 1);
  assert.equal(result.hybridResultCount, 1);
  assert.equal(result.sampleItemId, "src_gmail_main:email:msg_1");
});
