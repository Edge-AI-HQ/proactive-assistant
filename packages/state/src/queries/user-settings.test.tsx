// @vitest-environment jsdom
// /settings 是 gate 整个 UI 的 bootstrap 请求 —— 迁移前 hooks/useUserSettings
// 的 resilience 语义（重试/快速失败/登出待命）在 TQ 版必须原样保留，
// 用例等价改写自旧 useUserSettings.test.tsx。
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@pin-ai/core", () => ({
  proxyFetch: vi.fn(),
  proxyPost: vi.fn(),
  getTransportConfig: vi.fn(() => ({ baseUrl: "", getAuthHeaders: async () => ({}) })),
}));

import * as core from "@pin-ai/core";

import { useUserSettings } from "./user-settings";

const mockProxyFetch = vi.mocked(core.proxyFetch);

const SETTINGS_BODY = {
  generationLanguage: "en",
  autoGenerate: false,
  autoGenerateIntervalMinutes: 60,
  autoDreaming: false,
  autoCrystallize: false,
  metadata: {},
  ambientSources: {},
  notifyNewCards: false,
  notifyPermissionPromptedAt: null,
  onboardingCompletedAt: null,
  updatedAt: "2026-06-11T00:00:00Z",
};

function okResponse() {
  return { ok: true, status: 200, json: async () => SETTINGS_BODY } as unknown as Response;
}

function httpResponse(status: number) {
  return { ok: false, status, text: async () => "" } as unknown as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useUserSettings bootstrap resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("retries transient failures then succeeds", async () => {
    mockProxyFetch
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(httpResponse(503))
      .mockResolvedValueOnce(okResponse());

    const { result } = renderHook(() => useUserSettings("user-1"), { wrapper });

    await waitFor(() => expect(result.current.settings).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockProxyFetch).toHaveBeenCalledTimes(3);
  }, 15_000);

  test("never strands on loading: surfaces an error after retries are exhausted", async () => {
    mockProxyFetch.mockResolvedValue(httpResponse(503));

    const { result } = renderHook(() => useUserSettings("user-1"), { wrapper });

    await waitFor(() => expect(result.current.error).not.toBeNull(), {
      timeout: 15_000,
    });
    // 1 initial + 3 backoff retries（SETTINGS_RETRY_DELAYS_MS.length）
    expect(mockProxyFetch).toHaveBeenCalledTimes(4);
  }, 20_000);

  test("does not retry a definitive 4xx (e.g. 401 that survived token refresh)", async () => {
    mockProxyFetch.mockResolvedValue(httpResponse(401));

    const { result } = renderHook(() => useUserSettings("user-1"), { wrapper });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
  });

  test("logged out (userKey null) issues no fetch and stays loading", async () => {
    const { result } = renderHook(() => useUserSettings(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockProxyFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    expect(result.current.settings).toBeNull();
  });
});
