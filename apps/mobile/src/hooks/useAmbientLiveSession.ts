/**
 * RN useAmbientLiveSession —— dev hooks/useAmbientLiveSession.ts 的移植版。
 * 实时 live session 数据流：① 订阅 ambient-audio 原生转写事件（transcript-listener）
 * → live-transcript-store；② 5s 轮询本地 store 的 candidateWindows / rawTranscripts /
 * context raw events；③ 合并后经 live-session 的 liveSessionDataToSession 组装成 LiveSession。
 *
 * 与 dev 差异：RN 恒 native → 去掉 web-only demo（enableWebDemo / demoLiveScenarios）+
 * isNative 分支；原生桥用 RN transcript-listener（同步 addListener）。逻辑其余与 dev 一致。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  todayLocalDate,
  type AmbientCandidateWindow,
  type AmbientRawEvent,
  type AmbientSourceType,
  type AmbientTimelineStore,
} from "@pin-ai/core";

import { getAmbientTimelineStore } from "../ambient/timeline";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeCount } from "../lib/heat-probe";
import {
  candidateWindowsToLiveSessionContextItems,
  liveSessionDataToSession,
  rawTranscriptEventsToLiveSessionData,
  rawTranscriptEventsToHistory,
  rawEventsToLiveSessionContextItems,
  type LiveSession,
  type LiveSessionData,
  type LiveSessionContextItem,
  type LiveHistoryTranscript,
} from "../ambient/live/live-session";
import {
  applyAmbientLiveTranscriptUpdate,
  getAmbientLiveTranscriptSnapshot,
  getAmbientLiveTranscriptHistorySnapshot,
  showAmbientListening,
  subscribeAmbientLiveTranscript,
  applyCaptureSessionRotation,
} from "../ambient/live/live-transcript-store";
import {
  addAmbientLiveTranscriptListeners,
  type AmbientLiveTranscriptEvent,
} from "../ambient/live/transcript-listener";

interface UseAmbientLiveSessionOptions {
  ambientOn: boolean;
  /** 页面可见时才 5s 轮询本地 store + 订阅转写 store（省电/减热，WS8）；隐藏时停、
   *  切回先取快照补齐再恢复。native 桥（addAmbientLiveTranscriptListeners）与它无关、
   *  恒开——后台采集持续把转写写进 store；这里门控的只是"要不要为 store 变化重渲 UI"。 */
  active?: boolean;
  dismissible?: boolean;
}

interface UseAmbientLiveSessionResult {
  session: LiveSession | null;
  history: LiveHistoryTranscript[];
  /** Raw merged transcript data (today's replayed events + in-memory live
   *  stream), chronological. For consumers that render their own feed
   *  (e.g. the PIN hardware page's phone tab) instead of the Live card. */
  data: LiveSessionData | null;
  previewVisibleCount: number;
  isRealSession: boolean;
  dismiss: () => void;
}

let nativeLiveBridgeStarted = false;
let nativeLiveBridgeHandle: { remove: () => void } | null = null;
const LIVE_CONTEXT_SOURCE_TYPES: AmbientSourceType[] = [
  "health",
  "location",
  "visit",
  "motion",
  "sound",
  "calendar",
];
const LIVE_SESSION_TODAY_LIMIT = 10_000;

export function useAmbientLiveSession({
  ambientOn,
  active = true,
  dismissible = false,
}: UseAmbientLiveSessionOptions): UseAmbientLiveSessionResult {
  const [liveSessionData, setLiveSessionData] = useState<LiveSessionData | null>(
    () => getAmbientLiveTranscriptSnapshot(),
  );
  const [localHistory, setLocalHistory] = useState<LiveHistoryTranscript[]>(
    () => getAmbientLiveTranscriptHistorySnapshot(),
  );
  const [candidateWindows, setCandidateWindows] = useState<AmbientCandidateWindow[]>([]);
  const [rawTranscripts, setRawTranscripts] = useState<AmbientRawEvent[]>([]);
  const [rawContextEvents, setRawContextEvents] = useState<AmbientRawEvent[]>([]);
  const [liveDismissed, setLiveDismissed] = useState(false);

  // 转写 store 订阅 → 驱动本组件重渲。页面隐藏时退订（省电/减热，WS8）：隐藏态每个
  // 语音事件都 notify 会让整棵隐藏树空转重渲（批 1 残余 ~5 次/min，切 tab/锁屏期间）。
  // native 桥恒开、后台采集持续入 store；这里门控的只是 UI 重渲。切回可见先取一次快照
  // 补齐隐藏期间的变化，再重新订阅（与下方 5s 轮询同款范式）。
  useEffect(() => {
    if (!active) return;
    setLiveSessionData(getAmbientLiveTranscriptSnapshot());
    setLocalHistory(getAmbientLiveTranscriptHistorySnapshot());
    return subscribeAmbientLiveTranscript(() => {
      setLiveSessionData(getAmbientLiveTranscriptSnapshot());
      setLocalHistory(getAmbientLiveTranscriptHistorySnapshot());
    });
  }, [active]);

  useEffect(() => {
    if (!ambientOn) return;
    ensureNativeLiveTranscriptBridge();
  }, [ambientOn]);

  useEffect(() => {
    if (!ambientOn) {
      setCandidateWindows([]);
      setRawTranscripts([]);
      setRawContextEvents([]);
      return;
    }
    // 页面隐藏时停 5s 轮询（省电/减热，WS8）；保留已有数据 → 切回即时刷新。
    if (!active) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const refreshWindows = async () => {
      try {
        const store = getAmbientTimelineStore();
        await store.init();
        const localDate = todayLocalDate();
        const [windows, transcripts, rawContext] = await Promise.all([
          store.listCandidateWindows({ localDate, limit: LIVE_SESSION_TODAY_LIMIT }),
          store.listRawEvents({
            localDate,
            sourceType: "transcript",
            eventType: "transcript.ready",
            order: "asc",
            limit: LIVE_SESSION_TODAY_LIMIT,
          }),
          listLiveSessionRawContextEvents(store, localDate),
        ]);
        if (!cancelled) {
          setCandidateWindows(windows);
          setRawTranscripts(transcripts);
          setRawContextEvents(rawContext);
        }
      } catch {
        // 保留 transcript 驱动的 live session（本地存储不可用时不致命）。
      }
    };

    void refreshWindows();
    interval = setInterval(() => {
      probeCount("ambient.livePoll"); // __HEAT_PROBE__
      void refreshWindows();
    }, 5000);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [ambientOn, active]);

  const contextItems = useMemo(
    () => dedupeContextItems([
      ...rawEventsToLiveSessionContextItems(rawContextEvents),
      ...candidateWindowsToLiveSessionContextItems(candidateWindows),
    ]),
    [candidateWindows, rawContextEvents],
  );

  const rawHistory = useMemo(
    () => rawTranscriptEventsToHistory(rawTranscripts),
    [rawTranscripts],
  );

  const replaySessionData = useMemo(
    () => rawTranscriptEventsToLiveSessionData(rawTranscripts),
    [rawTranscripts],
  );

  const mergedLiveSessionData = useMemo(
    () => mergeLiveSessionData(replaySessionData, liveSessionData),
    [replaySessionData, liveSessionData],
  );

  const realSession = useMemo(
    () => liveSessionDataToSession(ambientOn, mergedLiveSessionData, contextItems),
    [ambientOn, mergedLiveSessionData, contextItems],
  );

  const history = useMemo(
    () => mergeHistoryTranscripts(
      localHistory,
      rawHistory,
      new Set(mergedLiveSessionData?.messages.map((message) => message.id) ?? []),
    ),
    [localHistory, rawHistory, mergedLiveSessionData],
  );

  const session = ambientOn && !liveDismissed ? realSession : null;

  useEffect(() => {
    setLiveDismissed(false);
  }, [liveSessionData?.captureSessionId, liveSessionData?.messages.length]);

  const dismiss = useCallback(() => {
    if (dismissible) setLiveDismissed(true);
  }, [dismissible]);

  return {
    session,
    history,
    data: mergedLiveSessionData,
    previewVisibleCount: session?.assists.length ?? 0,
    isRealSession: realSession !== null,
    dismiss,
  };
}

async function listLiveSessionRawContextEvents(
  store: Pick<AmbientTimelineStore, "listRawEvents">,
  localDate: string,
): Promise<AmbientRawEvent[]> {
  const bySource = await Promise.all(
    LIVE_CONTEXT_SOURCE_TYPES.map((sourceType) =>
      store.listRawEvents({ localDate, sourceType, order: "desc", limit: 1 }),
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

function mergeLiveSessionData(
  replay: LiveSessionData | null,
  live: LiveSessionData | null,
): LiveSessionData | null {
  if (!replay) return live;
  if (!live) return replay;
  const messagesById = new Map<string, LiveSessionData["messages"][number]>();
  for (const message of replay.messages) messagesById.set(message.id, message);
  for (const message of live.messages) messagesById.set(message.id, message);
  const messages = Array.from(messagesById.values())
    .sort((a, b) => (a.sortTs ?? Number.MAX_SAFE_INTEGER) - (b.sortTs ?? Number.MAX_SAFE_INTEGER));
  return {
    captureSessionId: live.captureSessionId,
    startedAt: Math.min(replay.startedAt, live.startedAt),
    messages,
  };
}

function ensureNativeLiveTranscriptBridge(): void {
  if (nativeLiveBridgeStarted || nativeLiveBridgeHandle) return;
  nativeLiveBridgeStarted = true;
  try {
    nativeLiveBridgeHandle = addAmbientLiveTranscriptListeners(handleNativeLiveEvent);
  } catch {
    nativeLiveBridgeStarted = false;
    nativeLiveBridgeHandle = null;
  }
}

function handleNativeLiveEvent(event: AmbientLiveTranscriptEvent): void {
  if (event.type === "audioState") {
    if (event.event.capturing) showAmbientListening();
    return;
  }
  if (event.type === "captureSessionRotated") {
    applyCaptureSessionRotation(event.event);
    return;
  }
  if (event.type === "speechBurst") {
    showAmbientListening(event.event.startedAt);
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

function mergeHistoryTranscripts(
  localHistory: LiveHistoryTranscript[],
  rawHistory: LiveHistoryTranscript[],
  excludedMessageIds: Set<string> = new Set(),
): LiveHistoryTranscript[] {
  const seen = new Set<string>();
  const merged: LiveHistoryTranscript[] = [];
  for (const item of [...localHistory, ...rawHistory]
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))) {
    if (excludedMessageIds.has(item.id)) continue;
    const key = `${item.captureSessionId}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(0, 5);
}
