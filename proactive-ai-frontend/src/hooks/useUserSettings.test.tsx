import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { UserSettings } from "./useUserSettings";

const { proxyFetchMock, proxyPostMock } = vi.hoisted(() => ({
  proxyFetchMock: vi.fn(),
  proxyPostMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  proxyFetch: proxyFetchMock,
  proxyPost: proxyPostMock,
}));

const SETTINGS: UserSettings = {
  generationLanguage: "en",
  autoGenerate: false,
  autoGenerateIntervalMinutes: 60,
  autoDreaming: false,
  autoCrystallize: false,
  metadata: {},
  ambientSources: {},
  notifyNewCards: true,
  notifyPermissionPromptedAt: null,
  onboardingCompletedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// Re-import with a fresh module registry each test so the module-level
// `settingsCache` starts empty and the mount effect always issues a fetch.
async function loadHook() {
  vi.resetModules();
  return (await import("./useUserSettings")).useUserSettings;
}

describe("useUserSettings bootstrap resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    proxyFetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("retries transient failures then succeeds", async () => {
    proxyFetchMock
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(jsonResponse(SETTINGS));

    const useUserSettings = await loadHook();
    const { result } = renderHook(() => useUserSettings());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(proxyFetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.settings).toEqual(SETTINGS);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("never strands on loading: surfaces an error after retries are exhausted", async () => {
    proxyFetchMock.mockRejectedValue(new Error("network down"));

    const useUserSettings = await loadHook();
    const { result } = renderHook(() => useUserSettings());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // 1 initial attempt + 3 backoff retries.
    expect(proxyFetchMock).toHaveBeenCalledTimes(4);
    expect(result.current.loading).toBe(false);
    expect(result.current.settings).toBeNull();
    expect(result.current.error).not.toBeNull();
  });

  test("does not retry a definitive 4xx (e.g. 401 that survived token refresh)", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse(null, 401));

    const useUserSettings = await loadHook();
    const { result } = renderHook(() => useUserSettings());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.settings).toBeNull();
    expect(result.current.error).not.toBeNull();
  });
});
