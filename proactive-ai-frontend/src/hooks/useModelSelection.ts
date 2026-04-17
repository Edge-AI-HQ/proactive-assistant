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
  };
}
