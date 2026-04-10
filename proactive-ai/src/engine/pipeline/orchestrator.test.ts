import { describe, expect, it, vi } from "vitest";
import { runPipeline } from "./orchestrator.js";

vi.mock("./feedback-summary.js", () => ({
  loadRecentFeedbackSummary: vi.fn(async () => []),
  formatRecentFeedbackSummary: vi.fn(() => ""),
}));

function createApi(messages: unknown[]) {
  return {
    logger: {
      info: vi.fn(),
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

  it("emits benchmark timing events and logger entries for each pipeline phase", async () => {
    const plannerOutput = JSON.stringify({
      reasoning: "Focus on one timely work item",
      intentsToGenerate: [
        {
          goalBasket: "work",
          objective: "Prepare the follow-up",
          dataSources: ["pin feedback"],
          whyNow: "The review is tomorrow",
          expectedAction: "Send a concise follow-up",
        },
      ],
    });
    const card = {
      id: "card_1",
      goalBasket: "work",
      title: "Send the follow-up",
      whyNow: "The review is tomorrow",
      summary: "Capture the key outcomes and next steps.",
      primaryAction: { label: "Send it", type: "confirm" },
      secondaryActions: [{ label: "Later", type: "snooze" }],
      confidence: 0.9,
      urgency: 0.8,
      importance: 0.85,
      sources: ["pin feedback"],
      agentChain: ["planner", "generator"],
      createdAt: "2026-04-09T00:00:00.000Z",
    };
    const generatorOutput = JSON.stringify({ cards: [card] });
    const evaluatorOutput = JSON.stringify({
      overall: 9.1,
      dimensions: {
        relevance: 9,
        actionability: 9,
        whyNowClarity: 9,
        novelty: 9,
        decisionCompression: 9,
      },
      feedback: "Ship it",
      pass: true,
    });
    const feedbackSynthOutput = JSON.stringify({
      iterationFeedback: "Strong result",
    });

    const messagesByRun = [
      [{ role: "assistant", content: plannerOutput }],
      [{ role: "assistant", content: generatorOutput }],
      [{ role: "assistant", content: evaluatorOutput }],
      [{ role: "assistant", content: feedbackSynthOutput }],
    ];

    const api = {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        subagent: {
          async run() {
            return { runId: `run_${messagesByRun.length}` };
          },
          async waitForRun() {
            return { status: "ok" as const };
          },
          async getSessionMessages() {
            return { messages: messagesByRun.shift() ?? [] };
          },
        },
      },
    };

    const events: Array<{ type: string; data: unknown }> = [];

    await runPipeline(
      api as never,
      { maxIterations: 1, agentTimeoutMs: 50 },
      (event) => {
        events.push(event);
      },
    );

    const timingEvents = events.filter((event) => event.type === "pipeline:timing");
    const timingLabels = timingEvents.map((event) => (event.data as { label: string }).label);

    expect(timingLabels).toEqual(expect.arrayContaining([
      "Feedback prefetch",
      "Context build total",
      "plan:1 breakdown",
      "Planner:1 total",
      "Evidence build total",
      "generate:1 breakdown",
      "Generator:1 total",
      "evaluate:1:card_1 breakdown",
      "Evaluator worker:card_1",
      "feedback:1 breakdown",
      "Feedback synth total",
      "Evaluator:1 total",
      "Iteration 1 total",
      "Candidate selection",
      "Pipeline total",
    ]));

    const traceEvents = events.filter((event) => event.type === "pipeline:trace");
    expect(traceEvents.some((event) => (event.data as { kind?: string }).kind === "context.summary")).toBe(true);
    expect(traceEvents.some((event) => (event.data as { kind?: string }).kind === "agent.prompt_stats")).toBe(true);
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("[timing]"));
  });
});
