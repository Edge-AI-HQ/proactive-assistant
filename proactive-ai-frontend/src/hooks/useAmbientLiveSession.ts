import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import type { AmbientLiveTranscriptEvent } from "@/services/ambient/transcript-listener";
import { isNative } from "@/lib/platform";
import {
  candidateWindowsToLiveSessionContextItems,
  liveSessionDataToSession,
  rawTranscriptEventsToLiveSessionData,
  rawEventsToLiveSessionContextItems,
  LIVE_SCENARIOS,
  type LiveSession,
  type LiveSessionData,
  type LiveSessionContextItem,
} from "@/services/ambient/live-session";
import {
  getAmbientTimelineStore,
  todayLocalDate,
  type AmbientCandidateWindow,
  type AmbientRawEvent,
  type AmbientSourceType,
  type AmbientTimelineStore,
} from "@/services/ambient/timeline";
import {
  applyAmbientLiveTranscriptUpdate,
  getAmbientLiveTranscriptSnapshot,
  showAmbientListening,
  subscribeAmbientLiveTranscript,
} from "@/services/ambient/live-transcript-store";

interface UseAmbientLiveSessionOptions {
  ambientOn: boolean;
  enableWebDemo?: boolean;
  dismissible?: boolean;
}

interface UseAmbientLiveSessionResult {
  session: LiveSession | null;
  previewVisibleCount: number;
  isRealSession: boolean;
  dismiss: () => void;
}

let nativeLiveBridgeStarted = false;
let nativeLiveBridgeHandle: PluginListenerHandle | null = null;
const LIVE_CONTEXT_SOURCE_TYPES: AmbientSourceType[] = [
  "health",
  "location",
  "visit",
  "motion",
  "sound",
  "calendar",
];

export function useAmbientLiveSession({
  ambientOn,
  enableWebDemo = false,
  dismissible = false,
}: UseAmbientLiveSessionOptions): UseAmbientLiveSessionResult {
  const [liveIndex, setLiveIndex] = useState(0);
  const [liveSessionData, setLiveSessionData] = useState<LiveSessionData | null>(
    () => getAmbientLiveTranscriptSnapshot(),
  );
  const [candidateWindows, setCandidateWindows] = useState<AmbientCandidateWindow[]>([]);
  const [rawTranscripts, setRawTranscripts] = useState<AmbientRawEvent[]>([]);
  const [rawContextEvents, setRawContextEvents] = useState<AmbientRawEvent[]>([]);
  const [liveDismissed, setLiveDismissed] = useState(false);
  const [previewVisibleCount, setPreviewVisibleCount] = useState(1);

  useEffect(() => {
    return subscribeAmbientLiveTranscript(() => {
      setLiveSessionData(getAmbientLiveTranscriptSnapshot());
    });
  }, []);

  useEffect(() => {
    if (!ambientOn || !isNative) return;
    ensureNativeLiveTranscriptBridge();
  }, [ambientOn]);

  useEffect(() => {
    if (!ambientOn || !isNative) {
      setCandidateWindows([]);
      setRawTranscripts([]);
      setRawContextEvents([]);
      return;
    }

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const refreshWindows = async () => {
      try {
        const store = getAmbientTimelineStore();
        await store.init();
        const localDate = todayLocalDate();
        const [windows, transcripts, rawContext] = await Promise.all([
          store.listCandidateWindows({
            localDate,
            limit: 50,
          }),
          store.listRawEvents({
            localDate,
            sourceType: "transcript",
            eventType: "transcript.ready",
            limit: 50,
          }),
          listLiveSessionRawContextEvents(store, localDate),
        ]);
        if (!cancelled) {
          setCandidateWindows(windows);
          setRawTranscripts(transcripts);
          setRawContextEvents(rawContext);
        }
      } catch {
        // Keep transcript-driven Live Session available if timeline storage is unavailable.
      }
    };

    void refreshWindows();
    interval = setInterval(() => void refreshWindows(), 5000);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [ambientOn]);

  const contextItems = useMemo(
    () => dedupeContextItems([
      ...rawEventsToLiveSessionContextItems(rawContextEvents),
      ...candidateWindowsToLiveSessionContextItems(candidateWindows),
    ]),
    [candidateWindows, rawContextEvents],
  );

  const replayedLiveSessionData = useMemo(
    () => rawTranscriptEventsToLiveSessionData(rawTranscripts),
    [rawTranscripts],
  );

  const effectiveLiveSessionData = liveSessionData ?? replayedLiveSessionData;

  const realSession = useMemo(
    () => liveSessionDataToSession(ambientOn, effectiveLiveSessionData, contextItems),
    [ambientOn, effectiveLiveSessionData, contextItems],
  );

  const session = ambientOn && !liveDismissed
    ? (realSession ?? (enableWebDemo && !isNative ? LIVE_SCENARIOS[liveIndex] : null))
    : null;

  useEffect(() => {
    if (!ambientOn || isNative || realSession || !enableWebDemo) return;
    const t = setInterval(() => {
      setLiveIndex((i) => (i + 1) % LIVE_SCENARIOS.length);
      setLiveDismissed(false);
    }, 12000);
    return () => clearInterval(t);
  }, [ambientOn, enableWebDemo, realSession]);

  useEffect(() => {
    setPreviewVisibleCount(1);
  }, [liveIndex, ambientOn, liveDismissed, effectiveLiveSessionData?.captureSessionId, realSession?.startedAt]);

  useEffect(() => {
    setLiveDismissed(false);
  }, [effectiveLiveSessionData?.captureSessionId, effectiveLiveSessionData?.messages.length]);

  useEffect(() => {
    if (realSession) {
      setPreviewVisibleCount(realSession.assists.length);
    }
  }, [realSession]);

  useEffect(() => {
    if (!session) return;
    if (previewVisibleCount >= session.assists.length) return;
    const t = setTimeout(() => setPreviewVisibleCount((c) => c + 1), 2600);
    return () => clearTimeout(t);
  }, [previewVisibleCount, session]);

  const dismiss = useCallback(() => {
    if (dismissible) setLiveDismissed(true);
  }, [dismissible]);

  return {
    session,
    previewVisibleCount,
    isRealSession: realSession !== null,
    dismiss,
  };
}

export async function listLiveSessionRawContextEvents(
  store: Pick<AmbientTimelineStore, "listRawEvents">,
  localDate: string,
): Promise<AmbientRawEvent[]> {
  const bySource = await Promise.all(
    LIVE_CONTEXT_SOURCE_TYPES.map((sourceType) =>
      store.listRawEvents({
        localDate,
        sourceType,
        order: "desc",
        limit: 1,
      }),
    ),
  );
  return bySource.flat();
}

function dedupeContextItems(items: LiveSessionContextItem[]): LiveSessionContextItem[] {
  const seen = new Set<string>();
  const unique: LiveSessionContextItem[] = [];
  for (const item of items) {
    const minute = item.startedAt.slice(0, 16);
    const key = `${item.kind}:${minute}:${item.label}:${item.summary ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function ensureNativeLiveTranscriptBridge(): void {
  if (nativeLiveBridgeStarted || nativeLiveBridgeHandle) return;
  nativeLiveBridgeStarted = true;
  void (async () => {
    try {
      const { addAmbientLiveTranscriptListeners } = await import(
        "@/services/ambient/transcript-listener"
      );
      nativeLiveBridgeHandle = await addAmbientLiveTranscriptListeners(handleNativeLiveEvent);
    } catch {
      nativeLiveBridgeStarted = false;
      nativeLiveBridgeHandle = null;
    }
  })();
}

function handleNativeLiveEvent(event: AmbientLiveTranscriptEvent): void {
  if (event.type === "audioState") {
    if (event.event.capturing) showAmbientListening();
    return;
  }
  if (event.type === "speechBurst") {
    showAmbientListening(event.event.timestamp);
    return;
  }
  if (event.type === "transcriptDraft") {
    applyAmbientLiveTranscriptUpdate({
      captureSessionId: event.event.captureSessionId,
      id: event.event.burstId,
      text: event.event.text,
      source: "draft",
    });
    return;
  }
  if (event.type === "transcriptReady") {
    applyAmbientLiveTranscriptUpdate({
      captureSessionId: event.event.captureSessionId,
      id: event.event.burstId,
      text: event.event.text,
      source: event.event.provider,
    });
    return;
  }
  applyAmbientLiveTranscriptUpdate({
    captureSessionId: event.event.captureSessionId,
    id: event.event.burstId,
    text: event.event.refinedText,
    source: event.event.provider,
  });
}
