import { useCallback, useEffect, useRef, useState } from "react";
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
} from "@/lib/api";

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
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilterState] = useState<MemoryListFilter>({
    status: "active",
    limit: DEFAULT_LIMIT,
    offset: 0,
    orderBy: "created_at",
    orderDirection: "desc",
  });

  const fetchAbortRef = useRef<AbortController | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const load = useCallback(async () => {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMemories(filterRef.current, controller.signal);
      if (controller.signal.aborted) return;
      setMemories(data.memories);
      setTotal(data.total ?? data.memories.length);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const setFilter = useCallback((next: MemoryListFilter) => {
    setFilterState(next);
  }, []);

  const create = useCallback(async (input: MemoryCreateInput) => {
    setMutating(true);
    setError(null);
    try {
      const res = await createMemory(input);
      await load();
      return res.memory;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setMutating(false);
    }
  }, [load]);

  const update = useCallback(async (id: string, patch: MemoryPatch) => {
    setMutating(true);
    setError(null);
    try {
      const res = await updateMemory(id, patch);
      await load();
      return res.memory;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setMutating(false);
    }
  }, [load]);

  const archive = useCallback(async (id: string) => {
    setMutating(true);
    setError(null);
    try {
      await archiveMemory(id);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setMutating(false);
    }
  }, [load]);

  const supersede = useCallback(async (oldId: string, input: MemoryCreateInput) => {
    setMutating(true);
    setError(null);
    try {
      const created = await createMemory(input);
      await supersedeMemory(oldId, created.memory.id);
      await load();
      return created.memory;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setMutating(false);
    }
  }, [load]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, filter, load]);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (enabledRef.current) void load();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      fetchAbortRef.current?.abort();
    };
  }, [enabled, load]);

  return {
    memories,
    total,
    loading,
    mutating,
    error,
    filter,
    setFilter,
    refetch: load,
    create,
    update,
    archive,
    supersede,
    clearError,
  };
}
