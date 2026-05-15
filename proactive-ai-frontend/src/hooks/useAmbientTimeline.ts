import { useCallback, useEffect, useMemo, useState } from "react";
import { isNative } from "@/lib/platform";
import {
  getAmbientTimelinePipeline,
  getAmbientTimelineStore,
  todayLocalDate,
  type AmbientTimelineEvent,
  type TimelineStoreStatus,
} from "@/services/ambient/timeline";

export interface UseAmbientTimelineResult {
  events: AmbientTimelineEvent[];
  localDate: string;
  loading: boolean;
  error: string | null;
  storeStatus: TimelineStoreStatus | null;
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}

export function useAmbientTimeline(localDate = todayLocalDate()): UseAmbientTimelineResult {
  const store = useMemo(() => getAmbientTimelineStore(), []);
  const pipeline = useMemo(() => getAmbientTimelinePipeline(), []);
  const [events, setEvents] = useState<AmbientTimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeStatus, setStoreStatus] = useState<TimelineStoreStatus | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      await store.init();
      await pipeline.regenerateDay(localDate);
      const rows = await store.listTimelineEvents(localDate, {
        visibleOnly: true,
        limit: 20,
      });
      setEvents(rows);
      setStoreStatus(store.status());
    } catch (err) {
      setError(describeError(err));
      setStoreStatus(store.status());
    } finally {
      setLoading(false);
    }
  }, [localDate, pipeline, store]);

  const dismiss = useCallback(async (id: string) => {
    await store.dismissTimelineEvent(id);
    await refresh();
  }, [refresh, store]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      await refresh();
      if (cancelled) return;
    })();
    const interval = isNative
      ? setInterval(() => {
        void refresh();
      }, 5_000)
      : null;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [refresh]);

  return {
    events,
    localDate,
    loading,
    error,
    storeStatus,
    refresh,
    dismiss,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
