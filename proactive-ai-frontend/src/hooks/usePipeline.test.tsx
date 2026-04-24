import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  proxyFetch: vi.fn(),
}));

import * as api from "@/lib/api";
import { usePipeline } from "./usePipeline";

const mockProxyFetch = vi.mocked(api.proxyFetch);

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

const advanceHealthPolling = async (): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  await flushAsyncWork();
};

describe("usePipeline health polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    mockProxyFetch.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("keeps gateway healthy through a single transient health failure", async () => {
    const healthResponses = [
      jsonResponse({ ok: true, pipelineRunning: false }),
      jsonResponse({ error: "Gateway proxy error" }, 502),
      jsonResponse({ ok: true, pipelineRunning: false }),
    ];
    mockProxyFetch.mockImplementation(async (path) => {
      if (path === "/health") {
        return healthResponses.shift() ?? jsonResponse({ ok: true, pipelineRunning: false });
      }
      if (path === "/status") {
        return jsonResponse({ pipelineRunning: false });
      }
      throw new Error(`unexpected proxy path ${path}`);
    });

    const { result, unmount } = renderHook(() => usePipeline());
    await flushAsyncWork();

    expect(result.current.health.ok).toBe(true);
    expect(result.current.health.error).toBeNull();

    await advanceHealthPolling();

    expect(result.current.health.ok).toBe(true);
    expect(result.current.health.error).toBeNull();

    await advanceHealthPolling();

    expect(result.current.health.ok).toBe(true);
    expect(result.current.health.error).toBeNull();

    unmount();
  });

  test("marks gateway failed after repeated health failures", async () => {
    const healthResponses = [
      jsonResponse({ ok: true, pipelineRunning: false }),
      jsonResponse({ error: "Gateway proxy error" }, 502),
      jsonResponse({ error: "Gateway proxy error" }, 502),
      jsonResponse({ error: "Gateway proxy error" }, 502),
    ];
    mockProxyFetch.mockImplementation(async (path) => {
      if (path === "/health") {
        return healthResponses.shift() ?? jsonResponse({ error: "Gateway proxy error" }, 502);
      }
      if (path === "/status") {
        return jsonResponse({ pipelineRunning: false });
      }
      throw new Error(`unexpected proxy path ${path}`);
    });

    const { result, unmount } = renderHook(() => usePipeline());
    await flushAsyncWork();

    expect(result.current.health.ok).toBe(true);

    await advanceHealthPolling();
    expect(result.current.health.ok).toBe(true);

    await advanceHealthPolling();
    expect(result.current.health.ok).toBe(true);

    await advanceHealthPolling();
    expect(result.current.health.ok).toBe(false);
    expect(result.current.health.error).toBe("Health check failed (502)");

    unmount();
  });
});
