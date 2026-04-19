import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  ensureContainer: vi.fn(),
  fetchContainerStatus: vi.fn(),
  probeGatewayHealth: vi.fn(),
  destroyContainer: vi.fn(),
}));

import * as api from "@/lib/api";
import { useContainer } from "./useContainer";

type GatewayProbeResult = Awaited<ReturnType<typeof api.probeGatewayHealth>>;

const mockEnsureContainer = vi.mocked(api.ensureContainer);
const mockFetchContainerStatus = vi.mocked(api.fetchContainerStatus);
const mockProbeGatewayHealth = vi.mocked(api.probeGatewayHealth);
const mockDestroyContainer = vi.mocked(api.destroyContainer);

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
    mockEnsureContainer.mockReset();
    mockFetchContainerStatus.mockReset();
    mockProbeGatewayHealth.mockReset();
    mockDestroyContainer.mockReset();
    mockDestroyContainer.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("marks the container as running when gateway health succeeds immediately", async () => {
    mockFetchContainerStatus.mockResolvedValue({ status: "running" });
    mockProbeGatewayHealth.mockResolvedValue(successProbe());

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    expect(result.current.status).toBe("running");
    expect(result.current.loading).toBe(false);
    expect(result.current.initialChecking).toBe(false);
  });

  test("falls back to none when a previously running container is deleted", async () => {
    mockFetchContainerStatus
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "none" });
    mockProbeGatewayHealth.mockResolvedValue(
      failedProbe("NO_CONTAINER", 503, "Container not ready"),
    );

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    expect(result.current.status).toBe("none");
    expect(result.current.loading).toBe(false);
    expect(result.current.initialChecking).toBe(false);
    expect(result.current.error).toContain("Launch again");
  });

  test("keeps polling after a transient proxy error and becomes running once health recovers", async () => {
    mockFetchContainerStatus.mockResolvedValue({ status: "none" });
    mockEnsureContainer.mockResolvedValue({
      containerId: "container-1",
      ready: true,
      status: "running",
    });
    mockProbeGatewayHealth
      .mockResolvedValueOnce(
        failedProbe("PROXY_ERROR", 502, "Container proxy error"),
      )
      .mockResolvedValueOnce(successProbe());

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    await act(async () => {
      await result.current.ensure();
    });
    await flushAsyncWork();

    expect(result.current.status).toBe("creating");
    expect(result.current.loading).toBe(true);

    await advancePolling();

    expect(result.current.status).toBe("running");
    expect(result.current.loading).toBe(false);
  });

  test("stops infinite loading after repeated gateway failures when the container status becomes stopped", async () => {
    mockFetchContainerStatus
      .mockResolvedValueOnce({ status: "none" })
      .mockResolvedValueOnce({ status: "stopped" });
    mockEnsureContainer.mockResolvedValue({
      containerId: "container-2",
      ready: true,
      status: "running",
    });
    mockProbeGatewayHealth.mockResolvedValue(
      failedProbe("PROXY_ERROR", 502, "Container proxy error"),
    );

    const { result } = renderHook(() => useContainer(true));
    await flushAsyncWork();

    await act(async () => {
      await result.current.ensure();
    });
    await flushAsyncWork();

    await advancePolling();
    await advancePolling();

    expect(result.current.status).toBe("stopped");
    expect(result.current.loading).toBe(false);
    expect(result.current.initialChecking).toBe(false);
  });
});
