import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { isNative } from "@/lib/platform";
import {
  appendTranscript,
  candidateWindowsToLiveSessionContextItems,
  liveSessionDataToSession,
  LIVE_SCENARIOS,
  type LiveSession,
  type LiveSessionData,
} from "@/services/ambient/live-session";
import {
  getAmbientTimelineStore,
  todayLocalDate,
  type AmbientCandidateWindow,
} from "@/services/ambient/timeline";

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

export function useAmbientLiveSession({
  ambientOn,
  enableWebDemo = false,
  dismissible = false,
}: UseAmbientLiveSessionOptions): UseAmbientLiveSessionResult {
  const [liveIndex, setLiveIndex] = useState(0);
  const [liveSessionData, setLiveSessionData] = useState<LiveSessionData | null>(null);
  const [candidateWindows, setCandidateWindows] = useState<AmbientCandidateWindow[]>([]);
  const [liveDismissed, setLiveDismissed] = useState(false);
  const [previewVisibleCount, setPreviewVisibleCount] = useState(1);

  useEffect(() => {
    if (!ambientOn || !isNative) {
      setLiveSessionData(null);
      return;
    }
    let cancelled = false;
    let handle: PluginListenerHandle | null = null;
    void (async () => {
      try {
        const { addAmbientTranscriptListener } = await import(
          "@/services/ambient/transcript-listener"
        );
        if (cancelled) return;
        const listenerHandle = await addAmbientTranscriptListener((event) => {
          if (cancelled) return;
          setLiveSessionData((prev) => appendTranscript(prev, event));
        });
        if (cancelled) {
          void listenerHandle.remove();
          return;
        }
        handle = listenerHandle;
      } catch {
        // Keep the UI in standby/demo mode if the native listener is unavailable.
      }
    })();
    return () => {
      cancelled = true;
      if (handle) void handle.remove();
    };
  }, [ambientOn]);

  useEffect(() => {
    if (!ambientOn || !isNative) {
      setCandidateWindows([]);
      return;
    }

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const refreshWindows = async () => {
      try {
        const store = getAmbientTimelineStore();
        await store.init();
        const windows = await store.listCandidateWindows({
          localDate: todayLocalDate(),
          limit: 50,
        });
        if (!cancelled) setCandidateWindows(windows);
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
    () => candidateWindowsToLiveSessionContextItems(candidateWindows),
    [candidateWindows],
  );

  const realSession = useMemo(
    () => liveSessionDataToSession(ambientOn, liveSessionData, contextItems),
    [ambientOn, liveSessionData, contextItems],
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
  }, [liveIndex, ambientOn, liveDismissed, liveSessionData?.captureSessionId, realSession?.startedAt]);

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
