import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  pinCliData,
  runPinCli,
  runPipeline,
  saveRun,
  recordGeneratedBatch,
  loadAutoLoopState,
  saveAutoLoopState,
} = vi.hoisted(() => ({
  pinCliData: vi.fn(),
  runPinCli: vi.fn(),
  runPipeline: vi.fn(),
  saveRun: vi.fn(),
  recordGeneratedBatch: vi.fn(),
  loadAutoLoopState: vi.fn(() => ({ lastFinishedAt: null })),
  saveAutoLoopState: vi.fn(),
}));

vi.mock("../pipeline/pin-cli.js", () => ({
  pinCliData,
  runPinCli,
}));

vi.mock("../pipeline/orchestrator.js", async () => {
  const actual = await vi.importActual<typeof import("../pipeline/orchestrator.js")>("../pipeline/orchestrator.js");
  return {
    ...actual,
    runPipeline,
  };
});

vi.mock("../pipeline/run-store.js", () => ({
  saveRun,
}));

vi.mock("../pending-store.js", () => ({
  loadAutoLoopState,
  saveAutoLoopState,
}));

vi.mock("../../core/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../core/index.js")>("../../core/index.js");
  return {
    ...actual,
    cards: {
      ...actual.cards,
      recordGeneratedBatch,
    },
  };
});

import { executeIncrementalPipeline } from "./pipeline-runner.js";

describe("executeIncrementalPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadAutoLoopState.mockReturnValue({ lastFinishedAt: null });
  });

  it("persists final cards into generated card history after a successful run", async () => {
    pinCliData.mockResolvedValue({
      runToken: "rt_123",
      generatedAt: "2026-04-10T10:00:00.000Z",
      items: { world: [], personal: [] },
      meta: { pendingCount: 2, oldestPendingAt: "2026-04-10T09:30:00.000Z" },
    });
    runPipeline.mockResolvedValue({
      runId: "run_manual_abc",
      iterations: [],
      completionStatus: "complete",
      warnings: [],
      finalCards: [
        {
          id: "card_1_1",
          goalBasket: "work",
          title: "Review queue with Alex",
          whyNow: "Two PRs are blocked today.",
          summary: "Alex is waiting on your review before noon.",
          primaryAction: { label: "Review now", type: "confirm" },
          secondaryActions: [],
          confidence: 0.9,
          urgency: 0.8,
          importance: 0.85,
          sources: ["calendar"],
          agentChain: ["planner", "generator"],
          createdAt: "2026-04-10",
        },
      ],
      totalIterations: 1,
    });
    runPinCli.mockResolvedValue({
      ok: true,
      data: { processedCount: 2 },
    });
    recordGeneratedBatch.mockResolvedValue([]);

    await executeIncrementalPipeline(
      {
        logger: { info() {}, warn() {}, error() {} },
      } as never,
      { trigger: "manual" },
    );

    expect(recordGeneratedBatch).toHaveBeenCalledTimes(1);
    expect(recordGeneratedBatch).toHaveBeenCalledWith(
      expect.objectContaining({ env: process.env }),
      expect.objectContaining({
        runId: "run_manual_abc",
        cards: [
          expect.objectContaining({
            id: "card_1_1",
            goalBasket: "work",
            title: "Review queue with Alex",
          }),
        ],
      }),
    );
  });

  it("does not persist generated card history when no pending incremental context exists", async () => {
    pinCliData.mockResolvedValue({
      runToken: null,
      generatedAt: "2026-04-10T10:00:00.000Z",
      items: { world: [], personal: [] },
      meta: { pendingCount: 0, oldestPendingAt: null },
    });

    const result = await executeIncrementalPipeline(
      {
        logger: { info() {}, warn() {}, error() {} },
      } as never,
      { trigger: "manual" },
    );

    expect(result).toEqual({
      ok: true,
      skipped: "no-pending",
      pending: 0,
    });
    expect(recordGeneratedBatch).not.toHaveBeenCalled();
  });

  it("passes through cardsPerIteration, agentTimeoutMs, and minAgeMs", async () => {
    pinCliData.mockResolvedValue({
      runToken: "rt_456",
      generatedAt: "2026-04-10T10:00:00.000Z",
      items: { world: [], personal: [] },
      meta: { pendingCount: 1, oldestPendingAt: "2026-04-10T09:30:00.000Z" },
    });
    runPipeline.mockResolvedValue({
      runId: "run_auto_cfg",
      iterations: [],
      completionStatus: "complete",
      warnings: [],
      finalCards: [],
      totalIterations: 0,
    });
    runPinCli.mockResolvedValue({
      ok: true,
      data: { processedCount: 1 },
    });
    recordGeneratedBatch.mockResolvedValue([]);

    await executeIncrementalPipeline(
      {
        logger: { info() {}, warn() {}, error() {} },
      } as never,
      {
        trigger: "auto",
        cardsPerIteration: 5,
        agentTimeoutMs: 123_000,
        minAgeMs: 60_000,
      },
    );

    expect(pinCliData).toHaveBeenCalledWith([
      "context",
      "incremental",
      "--limit",
      "200",
      "--min-age-ms",
      "60000",
    ]);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cardsPerIteration: 5,
        agentTimeoutMs: 123_000,
      }),
      undefined,
    );
  });
});
