import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCrystallizeState, forceCrystallizeRun, patchCrystallizeConfig, setAutoCrystallize, type CrystallizeRunResponse, type CrystallizeStateResponse, type TunableCrystallizeKey } from "@pin-ai/core";

export interface UseCrystallizeResult {
  state: CrystallizeStateResponse | null;
  loading: boolean;
  mutating: boolean;
  running: boolean;
  error: string | null;
  lastRun: CrystallizeRunResponse["result"] | null;
  refetch: () => Promise<void>;
  toggleAuto: (enabled: boolean) => Promise<void>;
  patchConfig: (patch: Partial<Record<TunableCrystallizeKey, number | null>>) => Promise<void>;
  forceRun: () => Promise<void>;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Reads + mutates the conversation crystallize state for the debug panel.
 * Source of truth is the backend — every mutation refetches afterwards.
 */
export function useCrystallize(enabled: boolean): UseCrystallizeResult {
  const [state, setState] = useState<CrystallizeStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<CrystallizeRunResponse["result"] | null>(null);

  const fetchAbortRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const load = useCallback(async () => {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCrystallizeState(controller.signal);
      if (controller.signal.aborted) return;
      setState(data);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const toggleAuto = useCallback(async (next: boolean) => {
    setMutating(true);
    setError(null);
    try {
      await setAutoCrystallize(next);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }, [load]);

  const patchConfig = useCallback(async (patch: Partial<Record<TunableCrystallizeKey, number | null>>) => {
    setMutating(true);
    setError(null);
    try {
      const data = await patchCrystallizeConfig(patch);
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }, []);

  const forceRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await forceCrystallizeRun();
      setLastRun(res.result);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [load]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const id = setInterval(() => {
      if (enabledRef.current) void load();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      fetchAbortRef.current?.abort();
    };
  }, [enabled, load]);

  return {
    state,
    loading,
    mutating,
    running,
    error,
    lastRun,
    refetch: load,
    toggleAuto,
    patchConfig,
    forceRun,
  };
}
