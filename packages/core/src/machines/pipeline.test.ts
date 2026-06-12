/**
 * Pipeline 状态机回放测试 —— 锁定 F5 安全网 / /status 恢复 / dispatch /
 * agent-runs 结算 / 孤儿采纳的全部转移分支（等价改写自旧
 * usePipeline.test.tsx 的两用例并补全未覆盖分支）。
 */
import { describe, expect, test } from "vitest";

import type { ActiveAgentRun } from "../api/agent-runs";
import {
  adoptOrphanRun,
  applyDispatchAccepted,
  applyDispatchError,
  applyRunFailure,
  applyRunResult,
  applyStatusCheck,
  createInitialRunState,
  dispatchingRunState,
  findOrphanGeneratorRun,
  hasServerActiveGenerator,
  parseStoredRunState,
  settleStaleRun,
  settleVanishedRun,
  type RunState,
} from "./pipeline";

const card = {
  id: "card_1",
  goalBasket: "work" as const,
  title: "Recovered card",
  whyNow: "because",
  summary: "because",
  primaryAction: { label: "Do it", type: "confirm" as const },
  secondaryActions: [],
  confidence: 0.8,
  urgency: 0.5,
  importance: 0.7,
  sources: [],
  sourceApps: [],
  reasoningSteps: [],
  agentChain: [],
  createdAt: "",
};

function runState(over: Partial<RunState>): RunState {
  return { ...createInitialRunState(), ...over };
}

describe("parseStoredRunState", () => {
  test("restores a valid stored state and normalizes cards", () => {
    const restored = parseStoredRunState(
      JSON.stringify(runState({ status: "running", finalCards: [card] })),
    );
    expect(restored?.status).toBe("running");
    expect(restored?.finalCards[0].id).toBe("card_1");
    expect(restored?.batchFeedback).toBeNull();
  });

  test("rejects corrupt / non-RunState payloads", () => {
    expect(parseStoredRunState("not json")).toBeNull();
    expect(parseStoredRunState(JSON.stringify({ status: 42 }))).toBeNull();
    expect(parseStoredRunState(null)).toBeNull();
  });
});

describe("settleStaleRun（F5 安全网）", () => {
  test("active with surviving cards → complete (keeps cards)", () => {
    const next = settleStaleRun(runState({ status: "running", finalCards: [card] }));
    expect(next.status).toBe("complete");
    expect(next.activePhase).toBe("complete");
    expect(next.finalCards).toHaveLength(1);
  });

  test("active without cards → idle", () => {
    const next = settleStaleRun(runState({ status: "connecting" }));
    expect(next.status).toBe("idle");
    expect(next.activePhase).toBeNull();
  });

  test("non-active state is returned by reference (no-op)", () => {
    const prev = runState({ status: "complete" });
    expect(settleStaleRun(prev)).toBe(prev);
  });
});

describe("applyStatusCheck（/status 恢复）", () => {
  test("pipelineRunning → running with reconnect log", () => {
    const next = applyStatusCheck(runState({ status: "idle" }), {
      pipelineRunning: true,
      phase: "generating",
    });
    expect(next?.status).toBe("running");
    expect(next?.activePhase).toBe("generating");
  });

  test("latest run failed → error, cards cleared（旧测试用例等价）", () => {
    const next = applyStatusCheck(runState({ status: "idle", finalCards: [card] }), {
      pipelineRunning: false,
      latestRun: { id: "run_new_failed", status: "failed", error: "subagent aborted" },
    });
    expect(next?.status).toBe("error");
    expect(next?.runId).toBe("run_new_failed");
    expect(next?.finalCards).toHaveLength(0);
    expect(next?.error).toBe("subagent aborted");
  });

  test("does NOT recover stale lastResult cards when latest run failed", () => {
    // failed 分支命中后就不会走 lastResult 恢复——两分支互斥由顺序保证。
    const next = applyStatusCheck(runState({ status: "idle" }), {
      pipelineRunning: false,
      latestRun: { id: "r2", status: "failed", error: "boom" },
      lastResult: { id: "r1", finalCards: [card] },
    });
    expect(next?.status).toBe("error");
    expect(next?.finalCards).toHaveLength(0);
  });

  test("completed lastResult with empty local cards → complete with recovered cards", () => {
    const next = applyStatusCheck(runState({ status: "idle" }), {
      pipelineRunning: false,
      lastResult: { id: "r1", finalCards: [card], batchFeedback: "looks good" },
    });
    expect(next?.status).toBe("complete");
    expect(next?.finalCards).toHaveLength(1);
    expect(next?.batchFeedback).toBe("looks good");
  });

  test("no actionable change → null", () => {
    expect(applyStatusCheck(runState({ status: "complete" }), { pipelineRunning: false })).toBeNull();
  });
});

describe("dispatch transitions", () => {
  test("dispatching → connecting with fresh state", () => {
    const next = dispatchingRunState();
    expect(next.status).toBe("connecting");
    expect(next.startedAt).not.toBeNull();
  });

  test("202 accepted records taskId and flips to running", () => {
    const next = applyDispatchAccepted(dispatchingRunState(), { taskId: "t1" });
    expect(next.status).toBe("running");
    expect(next.runId).toBe("t1");
    expect(next.activePhase).toBe("generating");
  });

  test("deduped 202 keeps following the existing run", () => {
    const next = applyDispatchAccepted(dispatchingRunState(), { runId: "t2", deduped: true });
    expect(next.runId).toBe("t2");
    expect(next.logEntries[0].title).toBe("Already running");
  });

  test("dispatch error → error with message", () => {
    const next = applyDispatchError(dispatchingRunState(), "HTTP 500");
    expect(next.status).toBe("error");
    expect(next.error).toBe("HTTP 500");
  });
});

describe("run settlement", () => {
  test("applyRunResult lands cards + batch feedback", () => {
    const next = applyRunResult(runState({ status: "running" }), [card], "fb");
    expect(next.status).toBe("complete");
    expect(next.finalCards).toHaveLength(1);
    expect(next.batchFeedback).toBe("fb");
  });

  test("applyRunResult with zero cards logs the declined reason", () => {
    const next = applyRunResult(runState({ status: "running" }), [], null);
    expect(next.logEntries[0].title).toBe("No new cards");
  });

  test("applyRunFailure → error", () => {
    const next = applyRunFailure(runState({ status: "running" }), "worker died");
    expect(next.status).toBe("error");
    expect(next.error).toBe("worker died");
  });

  test("settleVanishedRun keeps cards as complete, else idle", () => {
    expect(settleVanishedRun(runState({ status: "running", finalCards: [card] })).status).toBe("complete");
    expect(settleVanishedRun(runState({ status: "running" })).status).toBe("idle");
  });
});

describe("orphan adoption", () => {
  const orphan: ActiveAgentRun = {
    id: "orphan-1",
    kind: "generator.manual",
    status: "running",
    trigger: null,
    startedAt: "2026-06-11T00:00:00Z",
    completedAt: null,
    createdAt: null,
    updatedAt: null,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    progress: {},
    payload: {},
  };

  test("finds queued/running generator.manual runs only", () => {
    expect(findOrphanGeneratorRun([orphan])?.id).toBe("orphan-1");
    expect(findOrphanGeneratorRun([{ ...orphan, kind: "auto.dreaming" }])).toBeUndefined();
    expect(findOrphanGeneratorRun([{ ...orphan, status: "succeeded" }])).toBeUndefined();
    expect(hasServerActiveGenerator([orphan])).toBe(true);
  });

  test("adoptOrphanRun follows the run and stamps startedAt", () => {
    const next = adoptOrphanRun(createInitialRunState(), orphan);
    expect(next.runId).toBe("orphan-1");
    expect(next.status).toBe("running");
    expect(next.startedAt).toBe("2026-06-11T00:00:00Z");
    expect(next.logEntries[0].title).toBe("Resumed");
  });
});
