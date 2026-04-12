import { describe, expect, it, vi } from "vitest";
import { runPipeline } from "./orchestrator.js";

function createApi(messages: unknown[]) {
  const deleteSession = vi.fn(async () => {});

  return {
    api: {
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
          deleteSession,
        },
      },
    },
    deleteSession,
  };
}

function createApiSequence(input: {
  messageBatches: unknown[][];
  waitResults?: Array<{ status: "ok" | "error" | "timeout"; error?: string }>;
}) {
  let runIndex = 0;
  let waitIndex = 0;
  let messageIndex = 0;
  const deleteSession = vi.fn(async () => {});

  return {
    api: {
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      runtime: {
        subagent: {
          async run() {
            runIndex += 1;
            return { runId: `run_${runIndex}` };
          },
          async waitForRun() {
            return input.waitResults?.[waitIndex++] ?? { status: "ok" as const };
          },
          async getSessionMessages() {
            return { messages: input.messageBatches[messageIndex++] ?? [] };
          },
          deleteSession,
        },
      },
    },
    deleteSession,
  };
}

const plannerBatch = [
  {
    role: "assistant",
    content: `\`\`\`json
{
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
];

const generatorBatch = [
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
];

const evaluatorBatch = [
  {
    role: "assistant",
    content: `\`\`\`json
{
  "evaluations": [
    {
      "cardId": "placeholder",
      "overall": 8.4,
      "dimensions": {
        "relevance": 8.5,
        "actionability": 8.5,
        "whyNowClarity": 8.5,
        "novelty": 8.5,
        "decisionCompression": 9.0
      },
      "feedback": "Looks good",
      "pass": true
    }
  ],
  "bestCards": [],
  "iterationFeedback": "Looks good"
}
\`\`\``,
  },
];

describe("runPipeline", () => {
  it("surfaces provider errors stored in session messages even when waitForRun reports ok", async () => {
    const { api, deleteSession } = createApi([
      { role: "system", content: "HTTP 403 forbidden: Request not allowed" },
    ]);

    await expect(runPipeline(api as never, { maxIterations: 1, agentTimeoutMs: 50 })).rejects.toThrow(
      /Agent plan:1 failed: HTTP 403 forbidden: Request not allowed/,
    );
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("reports a helpful empty-response error when no agent output is available", async () => {
    const { api, deleteSession } = createApi([
      { role: "user", content: "Generate an intent card plan based on the user's current context." },
    ]);

    await expect(runPipeline(api as never, { maxIterations: 1, agentTimeoutMs: 50 })).rejects.toThrow(
      /Agent plan:1 returned empty response/,
    );
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("continues the pipeline when planner output contains raw quoted phrases in reasoning", async () => {
    const { api } = createApiSequence({
      messageBatches: [
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
        generatorBatch,
        [
          {
            role: "assistant",
            content: "No evaluation available",
          },
        ],
      ],
    });

    const result = await runPipeline(
      api as never,
      { maxIterations: 1, agentTimeoutMs: 50 },
    );

    expect(result.totalIterations).toBe(1);
    expect(result.finalCards).toHaveLength(1);
    expect(result.finalCards[0]?.title).toBe("Try one AI workflow today");
    expect(result.completionStatus).toBe("partial");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      iteration: 1,
      phase: "evaluating",
      fallback: "synthetic_evaluation",
    });
  });

  it("returns a partial result when a later planner phase fails after a successful iteration", async () => {
    const { api, deleteSession } = createApiSequence({
      messageBatches: [plannerBatch, generatorBatch, evaluatorBatch],
      waitResults: [
        { status: "ok" },
        { status: "ok" },
        { status: "ok" },
        { status: "timeout" },
      ],
    });

    const result = await runPipeline(api as never, { maxIterations: 2, agentTimeoutMs: 50 });

    expect(result.completionStatus).toBe("partial");
    expect(result.totalIterations).toBe(1);
    expect(result.finalCards).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      iteration: 2,
      phase: "planning",
      fallback: "previous_iteration",
    });
    expect(deleteSession).toHaveBeenCalledTimes(4);
  });

  it("falls back to synthetic evaluation when the evaluator phase times out", async () => {
    const { api, deleteSession } = createApiSequence({
      messageBatches: [plannerBatch, generatorBatch],
      waitResults: [
        { status: "ok" },
        { status: "ok" },
        { status: "timeout" },
      ],
    });

    const result = await runPipeline(api as never, { maxIterations: 1, agentTimeoutMs: 50 });

    expect(result.completionStatus).toBe("partial");
    expect(result.totalIterations).toBe(1);
    expect(result.finalCards).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      iteration: 1,
      phase: "evaluating",
      fallback: "synthetic_evaluation",
    });
    expect(result.iterations[0]?.evaluation.evaluations[0]?.pass).toBe(true);
    expect(deleteSession).toHaveBeenCalledTimes(3);
  });
});
