import { useCallback, useEffect, useRef, useState } from "react";
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
} from "@/lib/api";

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

/**
 * Read + mutate v3 skill_index rows for the debug panel.
 * Filter changes trigger an immediate refetch. 10s background poll while
 * the panel is enabled so freshly crystallized skills appear on their own.
 * `q` is client-side fuzzy matching on title/description; the backend has
 * no text search for skills (by design — the list is small).
 */
export function useSkills(enabled: boolean): UseSkillsResult {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilterState] = useState<UseSkillsFilter>({ status: "enabled" });

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
      const data = await fetchSkills({ status: filterRef.current.status }, controller.signal);
      if (controller.signal.aborted) return;
      const q = (filterRef.current.q ?? "").trim().toLowerCase();
      const filtered = q
        ? data.skills.filter(
            (s) =>
              s.title.toLowerCase().includes(q)
              || (s.description ?? "").toLowerCase().includes(q)
              || s.triggers.some((t) => t.toLowerCase().includes(q)),
          )
        : data.skills;
      setSkills(filtered);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const setFilter = useCallback((next: UseSkillsFilter) => {
    setFilterState(next);
  }, []);

  const getDetail = useCallback(async (id: string) => {
    try {
      const res = await fetchSkill(id);
      return res.skill;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  const create = useCallback(async (input: SkillCreateInput) => {
    setMutating(true);
    setError(null);
    try {
      const res = await createSkill(input);
      await load();
      return res.skill;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setMutating(false);
    }
  }, [load]);

  const update = useCallback(async (id: string, patch: SkillPatch) => {
    setMutating(true);
    setError(null);
    try {
      const res = await updateSkill(id, patch);
      await load();
      return res.skill;
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
      await archiveSkill(id);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setMutating(false);
    }
  }, [load]);

  const clearError = useCallback(() => setError(null), []);

  // Refetch on enable or filter change.
  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, filter, load]);

  // Background poll.
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
    skills,
    loading,
    mutating,
    error,
    filter,
    setFilter,
    refetch: load,
    getDetail,
    create,
    update,
    archive,
    clearError,
  };
}
