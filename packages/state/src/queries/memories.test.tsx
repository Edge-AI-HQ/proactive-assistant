// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@pin-ai/core", () => ({
  fetchMemories: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  archiveMemory: vi.fn(),
  supersedeMemory: vi.fn(),
}));

import * as core from "@pin-ai/core";

import { useMemories } from "./memories";

const mockFetchMemories = vi.mocked(core.fetchMemories);
const mockCreateMemory = vi.mocked(core.createMemory);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchMemories.mockResolvedValue({ ok: true, memories: [], total: 42 });
  });

  test("defaults debug memory reads to first 5 active rows", async () => {
    const { result } = renderHook(() => useMemories(true), { wrapper });

    await waitFor(() => expect(result.current.total).toBe(42));
    expect(mockFetchMemories).toHaveBeenCalledWith(
      {
        status: "active",
        limit: 5,
        offset: 0,
        orderBy: "created_at",
        orderDirection: "desc",
      },
      expect.any(AbortSignal),
    );
  });

  test("does not fetch when disabled", async () => {
    renderHook(() => useMemories(false), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchMemories).not.toHaveBeenCalled();
  });

  test("create invalidates and refetches the list; failure surfaces error and returns null", async () => {
    const { result } = renderHook(() => useMemories(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockCreateMemory.mockResolvedValueOnce({
      ok: true,
      memory: { id: "m1" } as never,
    });
    let created: unknown;
    await act(async () => {
      created = await result.current.create({ text: "t", source: "user" });
    });
    expect(created).toEqual({ id: "m1" });
    // mutation 成功后 invalidate → 列表重拉（首拉 1 次 + invalidate 1 次）
    expect(mockFetchMemories.mock.calls.length).toBeGreaterThanOrEqual(2);

    mockCreateMemory.mockRejectedValueOnce(new Error("boom"));
    let failed: unknown;
    await act(async () => {
      failed = await result.current.create({ text: "t", source: "user" });
    });
    expect(failed).toBeNull();
    expect(result.current.error).toBe("boom");

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
