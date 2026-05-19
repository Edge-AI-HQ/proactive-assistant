import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isNative } from "@/lib/platform";
import {
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

interface AmbientTimelineRuntime {
  refreshTimeline(localDate: string): Promise<void>;
}

export function useAmbientTimeline(localDate = todayLocalDate()): UseAmbientTimelineResult {
  const store = useMemo(() => getAmbientTimelineStore(), []);
  const runtimeRef = useRef<AmbientTimelineRuntime | null>(null);
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
    const pendingRawTranscriptIds = new Set(
      pending.flatMap((window) =>
        window.rawRefs
          .filter((ref) => ref.sourceType === "transcript")
          .map((ref) => ref.id),
      ),
    );
    setPendingTranscriptCount(pending.length);
    setPendingTranscriptWindows(pending);
    setLatestRawEvents(latestRaw.filter((raw) =>
      raw.sourceType !== "transcript" || !pendingRawTranscriptIds.has(raw.id),
    ));
    setEvents(rows.filter(isDisplayableTimelineEvent));
    setStoreStatus(store.status());
    setLoading(false);
  }, [localDate, store]);

  const runPendingGeneration = useCallback(() => {
    if (pendingGenerationRef.current) return pendingGenerationRef.current;
    const promise = (async () => {
      try {
        let runtime = runtimeRef.current;
        if (!runtime) {
          runtime = await loadNativeAmbientTimelineRuntime();
          if (!runtime) return;
          runtimeRef.current = runtime;
        }
        await runtime.refreshTimeline(localDate);
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
  }, [loadSnapshot, localDate, store]);

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
    "transcript",
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

async function loadNativeAmbientTimelineRuntime(): Promise<AmbientTimelineRuntime | null> {
  if (!isNative) return null;
  const { getAmbientRuntime } = await import("@/services/ambient");
  return getAmbientRuntime();
}

function isDisplayableTimelineEvent(event: AmbientTimelineEvent): boolean {
  if (!event.sourceTypes.includes("transcript")) return true;
  const isLlmSummary = event.generationSource === "llm_summary"
    || event.generationMethod === "local_llm";
  if (!isLlmSummary) return true;
  const invalidTime = !Number.isFinite(Date.parse(event.occurredAt));
  const placeholderText = isPlaceholderTimelineText(event.title)
    || isPlaceholderTimelineText(event.summary);
  return !invalidTime && !placeholderText;
}

function isPlaceholderTimelineText(value: string): boolean {
  return [
    "title",
    "short title",
    "summary",
    "one sentence",
    "specific title",
    "specific title from context",
    "specific summary",
    "specific summary from context",
    "title from context",
    "summary from context",
    "iso",
  ].includes(
    value.trim().toLowerCase(),
  );
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
