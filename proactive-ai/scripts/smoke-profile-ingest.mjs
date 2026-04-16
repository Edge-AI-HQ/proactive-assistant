/**
 * Smoke test for profile-ingest agent (no vitest / no esbuild).
 * Run: node scripts/smoke-profile-ingest.mjs
 */

import { runProfileIngestAgent } from "../dist/src/engine/profile-ingest/agent.js";

const assistantPayload = JSON.stringify({
  connector_history_batches: [],
  evidence_summary: "smoke: mock subagent",
  facts_delta: { "ingest.smoke": "ok" },
  preferences_delta: {},
  memory_candidates: [],
});

let runCalled = 0;
const api = {
  runtime: {
    subagent: {
      async run() {
        runCalled += 1;
        return { runId: "smoke-1" };
      },
      async waitForRun() {
        return { status: "ok" };
      },
      async getSessionMessages() {
        return {
          messages: [
            { role: "user", content: "x" },
            { role: "assistant", content: assistantPayload },
          ],
        };
      },
      async deleteSession() {},
    },
  },
};

const out = await runProfileIngestAgent(api, {
  toolkit: null,
  maxRecords: 10,
  persistToProfile: true,
});
if (runCalled !== 1) throw new Error(`expected run() once, got ${runCalled}`);
if (!Array.isArray(out.historyBatches)) {
  throw new Error("expected historyBatches array");
}
if (!out.subagentCompleted) {
  throw new Error("expected subagentCompleted");
}
if (!out.patch || out.patch.facts_delta?.["ingest.smoke"] !== "ok") {
  console.error(out);
  throw new Error("patch parse failed");
}
console.log("smoke-profile-ingest: OK", JSON.stringify(out.patch));
