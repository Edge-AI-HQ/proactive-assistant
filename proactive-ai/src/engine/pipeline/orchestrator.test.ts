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

function createApiSequence(messageBatches: unknown[][]) {
  let messageIndex = 0;

  return {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    runtime: {
      subagent: {
        async run() {
          return { runId: `run_${messageIndex + 1}` };
        },
        async waitForRun() {
          return { status: "ok" as const };
        },
        async getSessionMessages() {
          return { messages: messageBatches[messageIndex++] ?? [] };
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

  it("continues the pipeline when planner output contains raw quoted phrases in reasoning", async () => {
    const result = await runPipeline(
      createApiSequence([
        [
          {
            role: "assistant",
            content: `Now I have enough context to produce the plan.

\`\`\`json
{
  "reasoning": "此前用户打开了 3 张卡片但均未 confirm：growth 方向的"伊朗危机阅读清单"、wealth 方向的"通胀/能源敞口核查清单"。",
  "collectedContext": {},
  "intentsToGenerate": [
    {
      "goalBasket": "work",
      "objective": "Decide whether to try an AI workflow",
      "whyNow": "A new quarter just started",
      "expectedAction": "Try one AI-assisted workflow today",
      "supportingData": ["recent feedback"]
    }
  ]
}
\`\`\``,
          },
        ],
        [
          {
            role: "assistant",
            content: `\`\`\`json
{
  "cards": [
    {
      "id": "placeholder",
      "goalBasket": "work",
      "title": "Try one AI workflow today",
      "whyNow": "A new quarter just started",
      "summary": "You already showed interest in similar cards. This is a smaller, clearer next step.",
      "primaryAction": { "label": "Try one workflow", "type": "confirm" },
      "secondaryActions": [
        { "label": "Modify", "type": "modify" },
        { "label": "Later", "type": "snooze" },
        { "label": "Dismiss", "type": "dismiss" }
      ],
      "confidence": 0.8,
      "urgency": 0.6,
      "importance": 0.7,
      "sources": ["recent feedback"],
      "agentChain": ["planner", "generator"],
      "createdAt": "2026-04-11"
    }
  ]
}
\`\`\``,
          },
        ],
        [
          {
            role: "assistant",
            content: "No evaluation available",
          },
        ],
      ]) as never,
      { maxIterations: 1, agentTimeoutMs: 50 },
    );

    expect(result.totalIterations).toBe(1);
    expect(result.finalCards).toHaveLength(1);
    expect(result.finalCards[0]?.title).toBe("Try one AI workflow today");
  });
});
