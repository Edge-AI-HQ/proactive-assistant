import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  archiveSkill,
  createSkill,
  fetchSkill,
  fetchSkills,
  updateSkill,
  type Skill,
  type SkillCreateInput,
  type SkillPatch,
  type SkillStatus,
} from "@pin-ai/core";

export const skillsKeys = {
  all: ["skills"] as const,
  list: (status: SkillStatus | undefined) => [...skillsKeys.all, { status }] as const,
};

export interface UseSkillsFilter {
  status?: SkillStatus;
  q?: string;
}

export interface UseSkillsResult {
  skills: Skill[];
  loading: boolean;
  mutating: boolean;
  error: string | null;
  filter: UseSkillsFilter;
  setFilter: (next: UseSkillsFilter) => void;
  refetch: () => Promise<void>;
  getDetail: (id: string) => Promise<Skill | null>;
  create: (input: SkillCreateInput) => Promise<Skill | null>;
  update: (id: string, patch: SkillPatch) => Promise<Skill | null>;
  archive: (id: string) => Promise<boolean>;
  clearError: () => void;
}

const POLL_INTERVAL_MS = 10_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read + mutate v3 skill_index rows for the debug panel.
 * 10s background poll while the panel is enabled so freshly crystallized
 * skills appear on their own. `q` is client-side fuzzy matching on
 * title/description（派生过滤，不重打后端——the backend has no text search
 * for skills by design; 迁移前 q 变化会触发一次多余的重拉，现在不会）。
 */
export function useSkills(enabled: boolean): UseSkillsResult {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<UseSkillsFilter>({ status: "enabled" });
  const [mutationError, setMutationError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: skillsKeys.list(filter.status),
    queryFn: ({ signal }) => fetchSkills({ status: filter.status }, signal),
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const skills = useMemo(() => {
    const all = query.data?.skills ?? [];
    const q = (filter.q ?? "").trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.title.toLowerCase().includes(q)
        || (s.description ?? "").toLowerCase().includes(q)
        || s.triggers.some((t) => t.toLowerCase().includes(q)),
    );
  }, [query.data, filter.q]);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: skillsKeys.all }),
    [queryClient],
  );

  const createMut = useMutation({ mutationFn: createSkill, onSuccess: invalidate });
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SkillPatch }) => updateSkill(id, patch),
    onSuccess: invalidate,
  });
  const archiveMut = useMutation({ mutationFn: archiveSkill, onSuccess: invalidate });

  const getDetail = useCallback(async (id: string) => {
    try {
      return (await fetchSkill(id)).skill;
    } catch (err) {
      setMutationError(errorMessage(err));
      return null;
    }
  }, []);

  const create = useCallback(
    async (input: SkillCreateInput) => {
      setMutationError(null);
      try {
        return (await createMut.mutateAsync(input)).skill;
      } catch (err) {
        setMutationError(errorMessage(err));
        return null;
      }
    },
    [createMut],
  );

  const update = useCallback(
    async (id: string, patch: SkillPatch) => {
      setMutationError(null);
      try {
        return (await updateMut.mutateAsync({ id, patch })).skill;
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

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  const clearError = useCallback(() => setMutationError(null), []);

  return {
    skills,
    loading: query.isLoading,
    mutating: createMut.isPending || updateMut.isPending || archiveMut.isPending,
    error: mutationError ?? (query.error ? errorMessage(query.error) : null),
    filter,
    setFilter,
    refetch,
    getDetail,
    create,
    update,
    archive,
    clearError,
  };
}
