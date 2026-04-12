// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { DEFAULT_PIPELINE_OPTIONS } from "../../pipeline/orchestrator.js";

const { executeIncrementalPipeline } = vi.hoisted(() => ({
  executeIncrementalPipeline: vi.fn(),
}));

vi.mock("../pipeline-runner.js", () => ({
  executeIncrementalPipeline,
}));

import { handleAutoRun } from "./auto-run.js";
import type { RouteContext } from "../types.js";

function createContext(pluginConfig?: Record<string, unknown>) {
  let statusCode = 0;
  let payload = "";
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end(body: string) {
      payload = body;
    },
  };

  const ctx = {
    api: {
      pluginConfig,
      logger: { info() {}, warn() {}, error() {} },
    } as RouteContext["api"],
    url: new URL("http://localhost/proactive-ai/api/auto-run"),
    req: { method: "POST" } as RouteContext["req"],
    res: res as RouteContext["res"],
    subpath: "/auto-run",
  } satisfies RouteContext;

  return {
    ctx,
    get statusCode() {
      return statusCode;
    },
    get json() {
      return payload ? JSON.parse(payload) : null;
    },
  };
}

describe("handleAutoRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeIncrementalPipeline.mockResolvedValue({
      ok: true,
      runId: "run_auto_123",
      consumedPending: 3,
      cards: 4,
    });
  });

  it("passes recovery-related plugin config through to the pipeline runner", async () => {
    const response = createContext({
      max_iterations: 4,
      agent_timeout_ms: 456_000,
      cards_per_iteration: 6,
      auto_process_min_age_ms: 120_000,
      auto_loop_min_interval_ms: 900_000,
    });

    const handled = await handleAutoRun(response.ctx);

    expect(handled).toBe(true);
    expect(executeIncrementalPipeline).toHaveBeenCalledWith(
      response.ctx.api,
      expect.objectContaining({
        trigger: "auto",
        maxIterations: 4,
        agentTimeoutMs: 456_000,
        cardsPerIteration: 6,
        minAgeMs: 120_000,
        cooldownMs: 900_000,
        enforceCooldown: true,
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json).toEqual({
      ok: true,
      runId: "run_auto_123",
      consumedPending: 3,
      cards: 4,
    });
  });

  it("falls back to defaults when pluginConfig is missing", async () => {
    const response = createContext(undefined);

    const handled = await handleAutoRun(response.ctx);

    expect(handled).toBe(true);
    expect(executeIncrementalPipeline).toHaveBeenCalledWith(
      response.ctx.api,
      expect.objectContaining({
        trigger: "auto",
        maxIterations: DEFAULT_PIPELINE_OPTIONS.maxIterations,
        agentTimeoutMs: DEFAULT_PIPELINE_OPTIONS.agentTimeoutMs,
        cardsPerIteration: DEFAULT_PIPELINE_OPTIONS.cardsPerIteration,
        minAgeMs: DEFAULT_CONFIG.auto_process_min_age_ms,
        cooldownMs: DEFAULT_CONFIG.auto_loop_min_interval_ms,
        enforceCooldown: true,
      }),
    );
    expect(response.statusCode).toBe(200);
  });
});
