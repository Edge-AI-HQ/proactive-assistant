import { useCallback, useEffect, useMemo, useState } from "react";
import { isNative } from "@/lib/platform";
import { getAmbientRuntime } from "@/services/ambient";
import {
  getAmbientTimelineStore,
  todayLocalDate,
  buildAmbientNarrativeSummary,
  groupAmbientTimelineEvents,
  type AmbientTimelineEvent,
  type TimelineStoreStatus,
  type AmbientTimelineGroup,
} from "@/services/ambient/timeline";

export interface UseAmbientTimelineResult {
  events: AmbientTimelineEvent[];
  localDate: string;
  loading: boolean;
  error: string | null;
  storeStatus: TimelineStoreStatus | null;
  narrativeSummary: string | null;
  groups: AmbientTimelineGroup[];
  pendingTranscriptCount: number;
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}

export function useAmbientTimeline(localDate = todayLocalDate()): UseAmbientTimelineResult {
  const store = useMemo(() => getAmbientTimelineStore(), []);
  const runtime = useMemo(() => getAmbientRuntime(), []);
  const [events, setEvents] = useState<AmbientTimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeStatus, setStoreStatus] = useState<TimelineStoreStatus | null>(null);
  const [pendingTranscriptCount, setPendingTranscriptCount] = useState(0);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      await store.init();
      await runtime.refreshTimeline(localDate);
      const rows = await store.listTimelineEvents(localDate, {
        visibleOnly: true,
        limit: 20,
      });
      const pending = await store.listCandidateWindows({
        localDate,
        windowType: "transcript_session",
        status: "pending",
        limit: 100,
      });
      setPendingTranscriptCount(pending.length);
      setEvents(rows);
      setStoreStatus(store.status());
    } catch (err) {
      setError(describeError(err));
      setStoreStatus(store.status());
    } finally {
      setLoading(false);
    }
  }, [localDate, runtime, store]);

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

  const narrativeSummary = useMemo(() => buildAmbientNarrativeSummary(events), [events]);
  const groups = useMemo(() => groupAmbientTimelineEvents(events), [events]);

  return {
    events,
    localDate,
    loading,
    error,
    storeStatus,
    narrativeSummary,
    groups,
    pendingTranscriptCount,
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
