import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchMemories: vi.fn(),
}));

import * as api from "@/lib/api";
import { useMemories } from "./useMemories";

const mockFetchMemories = vi.mocked(api.fetchMemories);

const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); });
};

describe("useMemories", () => {
  beforeEach(() => {
    mockFetchMemories.mockReset();
    mockFetchMemories.mockResolvedValue({ ok: true, memories: [], total: 42 });
  });

  test("defaults debug memory reads to first 5 active rows", async () => {
    const { result } = renderHook(() => useMemories(true));
    await flush();

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
    expect(result.current.total).toBe(42);
  });
});
