import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isNative } from "@/lib/platform";
import {
  getAmbientTimelinePipeline,
  getAmbientTimelineStore,
  todayLocalDate,
  buildAmbientNarrativeSummary,
  groupAmbientTimelineEvents,
  type AmbientTimelineEvent,
  type AmbientRawEvent,
  type TimelineStoreStatus,
  type AmbientTimelineGroup,
  type AmbientCandidateWindow,
  type AmbientSourceType,
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
  pendingTranscriptWindows: AmbientCandidateWindow[];
  latestRawEvents: AmbientRawEvent[];
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
  const [pendingTranscriptCount, setPendingTranscriptCount] = useState(0);
  const [pendingTranscriptWindows, setPendingTranscriptWindows] = useState<AmbientCandidateWindow[]>([]);
  const [latestRawEvents, setLatestRawEvents] = useState<AmbientRawEvent[]>([]);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const pendingGenerationRef = useRef<Promise<void> | null>(null);

  const loadSnapshot = useCallback(async () => {
    await store.init();
    const [rows, pending, latestRaw] = await Promise.all([
      store.listTimelineEvents(localDate, {
        visibleOnly: true,
        limit: 100,
      }),
      store.listCandidateWindows({
        localDate,
        windowType: "transcript_session",
        status: "pending",
        limit: 100,
      }),
      loadLatestRawEvents(store, localDate),
    ]);
    setPendingTranscriptCount(pending.length);
    setPendingTranscriptWindows(pending);
    setLatestRawEvents(latestRaw);
    setEvents(rows);
    setStoreStatus(store.status());
    setLoading(false);
  }, [localDate, store]);

  const runPendingGeneration = useCallback(() => {
    if (pendingGenerationRef.current) return pendingGenerationRef.current;
    const promise = (async () => {
      try {
        await pipeline.processPendingWindows(localDate);
        await loadSnapshot();
      } catch (err) {
        setError(describeError(err));
        setStoreStatus(store.status());
      } finally {
        pendingGenerationRef.current = null;
      }
    })();
    pendingGenerationRef.current = promise;
    return promise;
  }, [loadSnapshot, localDate, pipeline, store]);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const promise = (async () => {
      setError(null);
      try {
        await loadSnapshot();
        void runPendingGeneration();
      } catch (err) {
        setError(describeError(err));
        setStoreStatus(store.status());
        setLoading(false);
      }
    })();
    refreshInFlightRef.current = promise;
    try {
      await promise;
    } finally {
      if (refreshInFlightRef.current === promise) {
        refreshInFlightRef.current = null;
      }
    }
  }, [loadSnapshot, runPendingGeneration, store]);

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
    pendingTranscriptWindows,
    latestRawEvents,
    refresh,
    dismiss,
  };
}

async function loadLatestRawEvents(
  store: ReturnType<typeof getAmbientTimelineStore>,
  localDate: string,
): Promise<AmbientRawEvent[]> {
  const sourceTypes: AmbientSourceType[] = [
    "health",
    "location",
    "motion",
    "sound",
    "visit",
    "calendar",
  ];
  const rows = await Promise.all(
    sourceTypes.map(async (sourceType) => {
      const latest = await store.listRawEvents({
        localDate,
        sourceType,
        order: "desc",
        limit: 1,
      });
      return latest[0] ?? null;
    }),
  );
  return rows.filter((row): row is AmbientRawEvent => Boolean(row));
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
