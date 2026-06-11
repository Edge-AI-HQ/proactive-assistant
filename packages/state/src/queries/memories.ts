/**
 * Memory 域 hook（分层 Phase 2 的迁移模板）。
 *
 * 设计约定（后续 hook 迁移照此模式）：
 * - state 包对外是「域 hook」而非裸 TQ hook：消费者拿到领域化的返回
 *   （memories/create/archive...），queryKey 与 invalidation 细节封装在内，
 *   三端（web/Electron/RN）消费同一接口。
 * - queryKey 工厂随域文件 collocate 导出（`memoriesKeys`），写操作统一
 *   invalidate `memoriesKeys.all`。
 * - 接口形状沿用迁移前的 hooks/useMemories.ts（UseMemoriesResult），消费者
 *   近零改动。行为差异仅一处：轮询/refetch 不再闪 loading（TQ 的 isLoading
 *   只在首拉为 true），属体验改善。
 */
import { useCallback, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  archiveMemory,
  createMemory,
  fetchMemories,
  supersedeMemory,
  updateMemory,
  type Memory,
  type MemoryCreateInput,
  type MemoryListFilter,
  type MemoryPatch,
} from "@pin-ai/core";

export const memoriesKeys = {
  all: ["memories"] as const,
  list: (filter: MemoryListFilter) => [...memoriesKeys.all, filter] as const,
};

export interface UseMemoriesResult {
  memories: Memory[];
  total: number;
  loading: boolean;
  mutating: boolean;
  error: string | null;
  filter: MemoryListFilter;
  setFilter: (next: MemoryListFilter) => void;
  refetch: () => Promise<void>;
  create: (input: MemoryCreateInput) => Promise<Memory | null>;
  update: (id: string, patch: MemoryPatch) => Promise<Memory | null>;
  archive: (id: string) => Promise<boolean>;
  supersede: (oldId: string, input: MemoryCreateInput) => Promise<Memory | null>;
  clearError: () => void;
}

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_LIMIT = 5;

const DEFAULT_FILTER: MemoryListFilter = {
  status: "active",
  limit: DEFAULT_LIMIT,
  offset: 0,
  orderBy: "created_at",
  orderDirection: "desc",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read + mutate v3 memory rows for the debug panel.
 *
 * Semantics follow `docs/plans/memory-architecture.mdx`:
 *   - archive: soft-delete, sets status='archived' (reversible).
 *   - supersede: create a new memory and link the old one via superseded_by.
 *   - update: in-place edit of text / quality / subject / tags (convenience
 *     shortcut; agent-driven evolution should prefer supersede to preserve
 *     the audit chain).
 */
export function useMemories(enabled: boolean): UseMemoriesResult {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<MemoryListFilter>(DEFAULT_FILTER);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: memoriesKeys.list(filter),
    queryFn: ({ signal }) => fetchMemories(filter, signal),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: memoriesKeys.all }),
    [queryClient],
  );

  const createMut = useMutation({ mutationFn: createMemory, onSuccess: invalidate });
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MemoryPatch }) =>
      updateMemory(id, patch),
    onSuccess: invalidate,
  });
  const archiveMut = useMutation({ mutationFn: archiveMemory, onSuccess: invalidate });
  const supersedeMut = useMutation({
    // supersede = create 新行 + 链接旧行，两步合一个 mutation 保持原子的
    // mutating 状态（与迁移前行为一致）。
    mutationFn: async ({ oldId, input }: { oldId: string; input: MemoryCreateInput }) => {
      const created = await createMemory(input);
      await supersedeMemory(oldId, created.memory.id);
      return created;
    },
    onSuccess: invalidate,
  });

  const create = useCallback(
    async (input: MemoryCreateInput) => {
      setMutationError(null);
      try {
        return (await createMut.mutateAsync(input)).memory;
      } catch (err) {
        setMutationError(errorMessage(err));
        return null;
      }
    },
    [createMut],
  );

  const update = useCallback(
    async (id: string, patch: MemoryPatch) => {
      setMutationError(null);
      try {
        return (await updateMut.mutateAsync({ id, patch })).memory;
      } catch (err) {
        setMutationError(errorMessage(err));
        return null;
      }
    },
    [updateMut],
  );

  const archive = useCallback(
    async (id: string) => {
      setMutationError(null);
      try {
        await archiveMut.mutateAsync(id);
        return true;
      } catch (err) {
        setMutationError(errorMessage(err));
        return false;
      }
    },
    [archiveMut],
  );

  const supersede = useCallback(
    async (oldId: string, input: MemoryCreateInput) => {
      setMutationError(null);
      try {
        return (await supersedeMut.mutateAsync({ oldId, input })).memory;
      } catch (err) {
        setMutationError(errorMessage(err));
        return null;
      }
    },
    [supersedeMut],
  );

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const clearError = useCallback(() => setMutationError(null), []);

  return {
    memories: query.data?.memories ?? [],
    total: query.data?.total ?? query.data?.memories.length ?? 0,
    loading: query.isLoading,
    mutating:
      createMut.isPending ||
      updateMut.isPending ||
      archiveMut.isPending ||
      supersedeMut.isPending,
    error: mutationError ?? (query.error ? errorMessage(query.error) : null),
    filter,
    setFilter,
    refetch,
    create,
    update,
    archive,
    supersede,
    clearError,
  };
}
