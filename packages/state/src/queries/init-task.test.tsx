// @vitest-environment jsdom
/**
 * Tests for useInitTask — the polling hook that drives the connector init
 * progress chip in DataConnections.
 *
 * Covers the contract the chip relies on:
 *   - null taskId → fully idle (no fetches, no state)
 *   - running task → keeps polling on the configured interval
 *   - terminal status → stops polling immediately
 *   - 404 → error + stop (chip falls silent)
 *
 * Note on timers: vitest + @testing-library/react's waitFor uses real
 * timers internally, so we drive state transitions with explicit
 * advanceTimersByTime + act+Promise-flush (matching the pattern in
 * useContainer.test.tsx) rather than waitFor.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@pin-ai/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  proxyFetch: vi.fn(),
}));

import * as api from "@pin-ai/core";
import { useInitTask } from "./init-task";

const mockProxyFetch = vi.mocked(api.proxyFetch);

type FetchResp = Pick<Response, "ok" | "status" | "json">;

function jsonResp(status: number, body: unknown): FetchResp {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "t1",
    type: "connector.init",
    status: "running",
    payload: { toolkit: "gmail", limit: 100 },
    progress: { stage: "fetch" },
    result: null,
    attempts: 1,
    max_attempts: 3,
    last_error_code: null,
    last_error_message: null,
    started_at: "2026-04-24T10:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

const POLL_INTERVAL_MS = 1_000; // matches init-task.ts (统一 1s)

const flush = async (cycles = 6): Promise<void> => {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
};

const advance = async (ms: number): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await flush();
};

describe("useInitTask", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockProxyFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("null taskId: never fetches, returns idle state", async () => {
    const { result } = renderHook(() => useInitTask(null));
    await flush();
    expect(mockProxyFetch).not.toHaveBeenCalled();
    expect(result.current.task).toBeNull();
    expect(result.current.terminal).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("running task: fetches initially and continues polling at the interval", async () => {
    mockProxyFetch.mockResolvedValue(jsonResp(200, { task: makeTask() }) as Response);
    const { result } = renderHook(() => useInitTask("t1"));
    await flush();
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    expect(result.current.task?.id).toBe("t1");
    expect(result.current.terminal).toBe(false);

    // Advance one polling cycle → second fetch
    await advance(POLL_INTERVAL_MS);
    expect(mockProxyFetch).toHaveBeenCalledTimes(2);

    // Another cycle → third fetch (still running)
    await advance(POLL_INTERVAL_MS);
    expect(mockProxyFetch).toHaveBeenCalledTimes(3);
  });

  test("terminal status: stops polling after first terminal response", async () => {
    mockProxyFetch
      .mockResolvedValueOnce(jsonResp(200, { task: makeTask({ status: "running" }) }) as Response)
      .mockResolvedValueOnce(jsonResp(200, { task: makeTask({
        status: "succeeded",
        result: { rawInserted: 12, memoriesWritten: 3 },
      }) }) as Response);

    const { result } = renderHook(() => useInitTask("t1"));
    await flush();
    expect(result.current.task?.status).toBe("running");

    await advance(POLL_INTERVAL_MS);
    expect(result.current.task?.status).toBe("succeeded");
    expect(result.current.terminal).toBe(true);
    expect(mockProxyFetch).toHaveBeenCalledTimes(2);

    // Subsequent ticks must NOT trigger more fetches
    await advance(POLL_INTERVAL_MS * 3);
    expect(mockProxyFetch).toHaveBeenCalledTimes(2);
  });

  test("404 response: surfaces error, clears task, stops polling", async () => {
    mockProxyFetch.mockResolvedValue(jsonResp(404, { error: "not found" }) as Response);
    const { result } = renderHook(() => useInitTask("missing"));
    await flush();
    expect(result.current.error).toBe("Task not found");
    expect(result.current.task).toBeNull();

    // No more polls
    await advance(POLL_INTERVAL_MS * 3);
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
  });

  test("transient 500: keeps polling (network blip)", async () => {
    mockProxyFetch
      .mockResolvedValueOnce(jsonResp(500, { error: "server" }) as Response)
      .mockResolvedValueOnce(jsonResp(200, { task: makeTask({ status: "running" }) }) as Response);

    const { result } = renderHook(() => useInitTask("t1"));
    await flush();
    expect(result.current.error).toMatch(/HTTP 500/);

    await advance(POLL_INTERVAL_MS);
    expect(result.current.task?.status).toBe("running");
    expect(result.current.error).toBeNull();
  });

  test("terminal 'failed' sets terminal=true with error messages", async () => {
    mockProxyFetch.mockResolvedValue(jsonResp(200, { task: makeTask({
      status: "failed",
      last_error_code: "composio_fetch_failed",
      last_error_message: "Composio API 503: upstream",
    }) }) as Response);

    const { result } = renderHook(() => useInitTask("t1"));
    await flush();
    expect(result.current.task?.status).toBe("failed");
    expect(result.current.task?.last_error_code).toBe("composio_fetch_failed");
    expect(result.current.terminal).toBe(true);
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);

    // No polling on terminal
    await advance(POLL_INTERVAL_MS * 3);
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
  });
});
