// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PIPELINE_OPTIONS } from "../../pipeline/orchestrator.js";

const { executeIncrementalPipeline, getGenerationLanguage } = vi.hoisted(() => ({
  executeIncrementalPipeline: vi.fn(),
  getGenerationLanguage: vi.fn(),
}));

vi.mock("../pipeline-runner.js", () => ({
  executeIncrementalPipeline,
}));

vi.mock("../local-settings.js", () => ({
  getGenerationLanguage,
}));

import { handleGenerate } from "./generate.js";
import type { RouteContext } from "../types.js";

function createContext(url: string, pluginConfig?: Record<string, unknown>) {
  const writes: string[] = [];
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(),
  };

  const ctx = {
    api: {
      pluginConfig,
      logger: { info() {}, warn() {}, error() {} },
    } as RouteContext["api"],
    url: new URL(url),
    req: { method: "GET" } as RouteContext["req"],
    res: res as RouteContext["res"],
    subpath: "/generate",
  } satisfies RouteContext;

  return { ctx, res, writes };
}

describe("handleGenerate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGenerationLanguage.mockReturnValue("zh-Hans");
    executeIncrementalPipeline.mockResolvedValue({
      ok: true,
      runId: "run_manual_123",
      consumedPending: 1,
      cards: 2,
    });
  });

  it("passes plugin config values through to the pipeline runner", async () => {
    const { ctx, res } = createContext(
      "http://localhost/proactive-ai/api/generate?iterations=7",
      {
        max_iterations: 4,
        agent_timeout_ms: 123_000,
        cards_per_iteration: 5,
      },
    );

    const handled = await handleGenerate(ctx);

    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/event-stream",
      }),
    );
    expect(executeIncrementalPipeline).toHaveBeenCalledWith(
      ctx.api,
      expect.objectContaining({
        trigger: "manual",
        maxIterations: 7,
        agentTimeoutMs: 123_000,
        cardsPerIteration: 5,
        enforceCooldown: false,
        outputLanguage: "zh-Hans",
        onEvent: expect.any(Function),
      }),
    );
    expect(res.end).toHaveBeenCalled();
  });

  it("falls back to defaults when pluginConfig is missing", async () => {
    const { ctx, res } = createContext(
      "http://localhost/proactive-ai/api/generate",
      undefined,
    );

    const handled = await handleGenerate(ctx);

    expect(handled).toBe(true);
    expect(executeIncrementalPipeline).toHaveBeenCalledWith(
      ctx.api,
      expect.objectContaining({
        trigger: "manual",
        maxIterations: DEFAULT_PIPELINE_OPTIONS.maxIterations,
        agentTimeoutMs: DEFAULT_PIPELINE_OPTIONS.agentTimeoutMs,
        cardsPerIteration: DEFAULT_PIPELINE_OPTIONS.cardsPerIteration,
        enforceCooldown: false,
        outputLanguage: "zh-Hans",
        onEvent: expect.any(Function),
      }),
    );
    expect(res.end).toHaveBeenCalled();
  });
});
