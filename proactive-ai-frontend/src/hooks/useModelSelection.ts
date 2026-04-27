import { useCallback, useEffect, useRef, useState } from "react";
import { fetchModels, changeModel, type ModelOption } from "@/lib/api";

export interface UseModelSelectionResult {
  models: ModelOption[];
  currentModel: string | null;
  defaultModel: string | null;
  loading: boolean;
  changing: boolean;
  error: string | null;
  change: (ref: string) => Promise<void>;
  refetch: () => Promise<void>;
  /** Retry the most recent failed `change`. If no change has been
   *  attempted yet, falls back to refetching the model list so the
   *  Retry button still does something useful. */
  retry: () => Promise<void>;
}

/**
 * Fetches the available model list + current selection from the backend.
 * Source of truth is the gateway — we always refetch after a change rather
 * than optimistically updating local state.
 */
export function useModelSelection(enabled: boolean): UseModelSelectionResult {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAbortRef = useRef<AbortController | null>(null);
  const changeAbortRef = useRef<AbortController | null>(null);
  // Track the model ref of the most recent change attempt so the Retry
  // button can re-fire the same /models/change request rather than just
  // refetching the list (which leaves the bad state in place).
  const lastAttemptedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const data = await fetchModels(controller.signal);
      if (controller.signal.aborted) return;
      setModels(data.available_models);
      setCurrentModel(data.current_model);
      setDefaultModel(data.default_model);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const change = useCallback(async (ref: string) => {
    lastAttemptedRef.current = ref;
    changeAbortRef.current?.abort();
    const controller = new AbortController();
    changeAbortRef.current = controller;

    setChanging(true);
    setError(null);
    try {
      await changeModel(ref, controller.signal);
      if (controller.signal.aborted) return;
      // Refetch to confirm from the gateway rather than trust local state.
      await load();
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setChanging(false);
    }
  }, [load]);

  const retry = useCallback(async () => {
    const ref = lastAttemptedRef.current;
    if (ref) {
      await change(ref);
    } else {
      await load();
    }
  }, [change, load]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    return () => {
      fetchAbortRef.current?.abort();
      changeAbortRef.current?.abort();
    };
  }, [enabled, load]);

  return {
    models,
    currentModel,
    defaultModel,
    loading,
    changing,
    error,
    change,
    refetch: load,
    retry,
  };
}
