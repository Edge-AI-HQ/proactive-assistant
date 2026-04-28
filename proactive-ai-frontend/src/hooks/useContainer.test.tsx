import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchContainerStatus: vi.fn(),
  probeGatewayHealth: vi.fn(),
  destroyContainer: vi.fn(),
  resetContainer: vi.fn(),
}));

import * as api from "@/lib/api";
import { useContainer } from "./useContainer";

type GatewayProbeResult = Awaited<ReturnType<typeof api.probeGatewayHealth>>;

const mockFetchContainerStatus = vi.mocked(api.fetchContainerStatus);
const mockProbeGatewayHealth = vi.mocked(api.probeGatewayHealth);
const mockDestroyContainer = vi.mocked(api.destroyContainer);
const mockResetContainer = vi.mocked(api.resetContainer);

const successProbe = (): GatewayProbeResult => ({
  ok: true,
  httpStatus: 200,
});

const failedProbe = (
  code: "NO_CONTAINER" | "PROXY_ERROR" | "RESUMING" | "CONTAINER_NOT_RUNNING",
  httpStatus: number,
  message: string,
): GatewayProbeResult => ({
  ok: false,
  httpStatus,
  code,
  message,
});

const flushAsyncWork = async (cycles = 5): Promise<void> => {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const advancePolling = async (ms = 3000): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flushAsyncWork();
};

describe("useContainer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchContainerStatus.mockReset();
    mockProbeGatewayHealth.mockReset();
    mockDestroyContainer.mockReset();
    mockResetContainer.mockReset();
    mockDestroyContainer.mockResolvedValue({ ok: true });
    mockResetContainer.mockResolvedValue({ ok: true, containerId: "c1", ready: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("flips to ready when an existing running container's gateway probe succeeds", async () => {
    mockFetchContainerStatus.mockResolvedValue({ status: "running" });
    mockProbeGatewayHealth.mockResolvedValue(successProbe());

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    expect(result.current.status).toBe("ready");
    expect(result.current.firstTime).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("starts in unknown and lands in unhealthy + firstTime when no container exists", async () => {
    mockFetchContainerStatus.mockResolvedValue({ status: "none" });

    const { result } = renderHook(() => useContainer(true));
    expect(result.current.status).toBe("unknown");

    await flushAsyncWork();

    expect(result.current.status).toBe("unhealthy");
    expect(result.current.firstTime).toBe(true);
    expect(result.current.error).toBeNull();
  });

  test("short-circuits to unhealthy + firstTime when gateway reports NO_CONTAINER", async () => {
    mockFetchContainerStatus.mockResolvedValue({ status: "running" });
    mockProbeGatewayHealth.mockResolvedValue(
      failedProbe("NO_CONTAINER", 503, "Container not available"),
    );

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    expect(result.current.status).toBe("unhealthy");
    expect(result.current.firstTime).toBe(true);
  });

  test("reaches ready when a transient probe error recovers within the budget", async () => {
    mockFetchContainerStatus.mockResolvedValue({ status: "running" });
    mockProbeGatewayHealth
      .mockResolvedValueOnce(failedProbe("PROXY_ERROR", 502, "Container proxy error"))
      .mockResolvedValueOnce(successProbe());

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    expect(result.current.status).toBe("connecting");

    await advancePolling();

    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  test("recreate() calls /reset and re-enters the probe loop", async () => {
    mockFetchContainerStatus.mockResolvedValue({ status: "none" });
    mockProbeGatewayHealth.mockResolvedValue(successProbe());

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    expect(result.current.status).toBe("unhealthy");
    expect(result.current.firstTime).toBe(true);

    await act(async () => {
      await result.current.recreate();
    });
    await flushAsyncWork();

    expect(mockResetContainer).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.firstTime).toBe(false);
  });

  test("cancel() destroys the container and drops into unhealthy + firstTime", async () => {
    mockFetchContainerStatus.mockResolvedValue({ status: "running" });
    mockProbeGatewayHealth.mockResolvedValue(
      failedProbe("PROXY_ERROR", 502, "Container proxy error"),
    );

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    expect(result.current.status).toBe("connecting");

    await act(async () => {
      await result.current.cancel();
    });

    expect(mockDestroyContainer).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("unhealthy");
    expect(result.current.firstTime).toBe(true);
  });
});
