import test from "node:test";
import assert from "node:assert/strict";

import { handleGenerate } from "./generate.ts";

test("handleGenerate best-effort syncs card-chat feedback before pipeline execution", async () => {
  const state = { running: false, phase: null, iteration: null };
  const calls: string[] = [];

  const handler = handleGenerate(
    state,
    { max_iterations: 1, cards_per_iteration: 8, agent_timeout_ms: 60_000 },
    {
      getUserSettings: async () => ({ generation_language: "en" }),
      syncCardChatFeedback: async () => {
        calls.push("sync");
      },
      runPipeline: async (_api, _opts, onEvent) => {
        calls.push("pipeline");
        onEvent?.({ type: "pipeline:start", data: { maxIterations: 1 } });
        return { runId: "run-1", totalIterations: 1, finalCards: [], scoreMap: {} };
      },
    },
  );

  const writes: string[] = [];
  const response = {
    writeHead: () => undefined,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => undefined,
  };

  const handled = await handler({
    subpath: "/generate",
    req: { method: "GET" },
    res: response,
    url: new URL("http://localhost/generate"),
    api: { logger: { error: () => undefined } },
  } as never);

  assert.equal(handled, true);
  assert.deepEqual(calls, ["sync", "pipeline"]);
  assert.equal(state.running, false);
  assert.equal(state.phase, null);
  assert.match(writes.join(""), /pipeline:start/);
});
