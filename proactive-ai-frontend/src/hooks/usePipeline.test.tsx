import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  proxyFetch: vi.fn(),
}));

import * as api from "@/lib/api";
import { usePipeline } from "./usePipeline";

const mockProxyFetch = vi.mocked(api.proxyFetch);

// usePipeline 内部的 useActiveAgentRuns 是 TQ hook（@pin-ai/state），需要
// Provider。本测试 mock 掉 "@/lib/api"（含 transport bootstrap），agent-runs
// 的 queryFn 会因 transport 未配置而失败 → runs=[]，与迁移前 mock 响应不含
// runs 字段时的行为一致；retry 关掉避免 fake-timers 下的重试噪音。
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const flushAsyncWork = async (cycles = 5): Promise<void> => {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

describe("usePipeline run-state recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    mockProxyFetch.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("settles stale restored running state when backend is no longer running", async () => {
    sessionStorage.setItem(
      "proactive-ai-run-state",
      JSON.stringify({
        runId: "run_previous",
        status: "running",
        activePhase: "generating",
        startedAt: "2026-04-24T23:20:00.000Z",
        completedAt: null,
        finalCards: [
          {
            id: "card_1",
            goalBasket: "work",
            title: "Recovered card",
            whyNow: "Because the previous run completed",
            primaryAction: { label: "Do it", type: "confirm" },
            secondaryActions: [],
            confidence: 0.8,
            urgency: 0.5,
            importance: 0.7,
            sources: [],
          },
        ],
        scoreMap: {},
        logEntries: [],
        error: null,
      }),
    );

    mockProxyFetch.mockImplementation(async (path) => {
      if (path === "/status") {
        return jsonResponse({ pipelineRunning: false });
      }
      throw new Error(`unexpected proxy path ${path}`);
    });

    const { result, unmount } = renderHook(() => usePipeline(), { wrapper });
    await flushAsyncWork();

    expect(result.current.run.status).toBe("complete");
    expect(result.current.isRunning).toBe(false);
    expect(result.current.run.finalCards).toHaveLength(1);
    expect(result.current.run.activePhase).toBe("complete");

    unmount();
  });

  test("does not recover stale cards when latest backend run failed", async () => {
    mockProxyFetch.mockImplementation(async (path) => {
      if (path === "/status") {
        return jsonResponse({
          ok: true,
          pipelineRunning: false,
          latestRun: {
            id: "run_new_failed",
            status: "failed",
            completedAt: "2026-05-01T03:46:48.820Z",
            error: "subagent aborted",
          },
          lastResult: {
            id: "run_old_completed",
            status: "completed",
            completedAt: "2026-04-16T04:51:05.050Z",
            finalCards: [
              {
                id: "old_1",
                goalBasket: "work",
                title: "Old English card",
                whyNow: "Because an old run completed",
                primaryAction: { label: "Do it", type: "confirm" },
                secondaryActions: [],
                confidence: 0.8,
                urgency: 0.5,
                importance: 0.7,
                sources: [],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected proxy path ${path}`);
    });

    const { result, unmount } = renderHook(() => usePipeline(), { wrapper });
    await flushAsyncWork();

    expect(result.current.run.status).toBe("error");
    expect(result.current.run.runId).toBe("run_new_failed");
    expect(result.current.run.finalCards).toHaveLength(0);
    expect(result.current.run.error).toBe("subagent aborted");

    unmount();
  });
});
