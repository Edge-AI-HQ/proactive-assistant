// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@pin-ai/core", () => ({
  fetchProfileSnapshot: vi.fn(),
  fetchMemories: vi.fn(),
}));

import * as core from "@pin-ai/core";

import { useProfileMemories, useProfileSnapshot } from "./profile";

const mockFetchProfileSnapshot = vi.mocked(core.fetchProfileSnapshot);
const mockFetchMemories = vi.mocked(core.fetchMemories);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useProfileSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchProfileSnapshot.mockResolvedValue({
      profile: { display_name: "Liam" },
      goals: [
        { key: "g1", status: "open" },
        { key: "g2", status: "closed" },
      ],
      memories: [],
      signals: [],
      interests: [],
    } as never);
  });

  test("returns the profile and drops closed goals", async () => {
    const { result } = renderHook(() => useProfileSnapshot(true), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profile?.display_name).toBe("Liam");
    expect(result.current.activeGoals.map((g) => g.key)).toEqual(["g1"]);
  });

  test("does not fetch when disabled", async () => {
    renderHook(() => useProfileSnapshot(false), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchProfileSnapshot).not.toHaveBeenCalled();
  });
});

describe("useProfileMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("loads the first page newest-first and accumulates on loadMore", async () => {
    const firstPage = Array.from({ length: 5 }, (_, i) => ({ id: `m${i + 1}` }));
    mockFetchMemories
      .mockResolvedValueOnce({ ok: true, memories: firstPage, total: 7 } as never)
      .mockResolvedValueOnce({
        ok: true,
        memories: [{ id: "m6" }, { id: "m7" }],
        total: 7,
      } as never);

    const { result } = renderHook(() => useProfileMemories(true), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.memories).toHaveLength(5);
    expect(result.current.hasMore).toBe(true);
    expect(mockFetchMemories).toHaveBeenCalledWith(
      { status: "active", limit: 5, offset: 0, orderBy: "created_at", orderDirection: "desc" },
      expect.any(AbortSignal),
    );

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.memories).toHaveLength(7));
    expect(result.current.hasMore).toBe(false);
    expect(mockFetchMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 5 }),
      expect.any(AbortSignal),
    );
  });
});
