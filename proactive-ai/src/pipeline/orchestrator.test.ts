import { describe, expect, it } from "vitest";
import { runPipeline } from "./orchestrator.js";

function createApi(messages: unknown[]) {
  return {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    runtime: {
      subagent: {
        async run() {
          return { runId: "run_1" };
        },
        async waitForRun() {
          return { status: "ok" as const };
        },
        async getSessionMessages() {
          return { messages };
        },
      },
    },
  };
}

describe("runPipeline", () => {
  it("surfaces provider errors stored in session messages even when waitForRun reports ok", async () => {
    await expect(
      runPipeline(
        createApi([
          { role: "system", content: "HTTP 403 forbidden: Request not allowed" },
        ]) as never,
        { maxIterations: 1, agentTimeoutMs: 50 },
      ),
    ).rejects.toThrow(/Agent plan:1 failed: HTTP 403 forbidden: Request not allowed/);
  });

  it("reports a helpful empty-response error when no agent output is available", async () => {
    await expect(
      runPipeline(
        createApi([
          { role: "user", content: "Generate an intent card plan based on the user's current context." },
        ]) as never,
        { maxIterations: 1, agentTimeoutMs: 50 },
      ),
    ).rejects.toThrow(/Agent plan:1 returned empty response/);
  });
});
