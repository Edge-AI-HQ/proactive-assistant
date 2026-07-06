/**
 * RN ambient timeline hook —— dev useAmbientTimeline 的精简对应物。
 * 读本地 SqliteTimelineStore（= dev 架构），产出当天「可见」的 AmbientTimelineEvent +
 * 叙事摘要（core buildAmbientNarrativeSummary，纯模板）。LLM 摘要事件经
 * isDisplayableTimelineEvent 过滤（占位符文案 / 坏时间戳不显示，dev :214-241）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildAmbientNarrativeSummary,
  todayLocalDate,
  type AmbientCandidateWindow,
  type AmbientRawEvent,
  type AmbientSourceType,
  type AmbientTimelineEvent,
  type AmbientTimelineStore,
  type TimelineStoreStatus,
} from "@pin-ai/core";

import { getAmbientTimelineStore } from "../ambient/timeline";
// __HEAT_PROBE__ 临时发热探针(排查完删)。
import { probeCount } from "../lib/heat-probe";

export interface UseAmbientTimelineResult {
  events: AmbientTimelineEvent[];
  /** 待端侧摘要的转写窗口（进 timeline 显示，对齐 dev）。 */
  pendingTranscriptWindows: AmbientCandidateWindow[];
  /** 每源最新一条原始事件（缺 LLM 摘要时 timeline 也有内容，对齐 dev）。 */
  latestRawEvents: AmbientRawEvent[];
  localDate: string;
  loading: boolean;
  error: string | null;
  /** 本地 store 状态（空态里显示 lastError，对齐 dev :781-785）。 */
  storeStatus: TimelineStoreStatus | null;
  /** 当天叙事摘要（<2 条可见事件时为 null，对齐 dev）。 */
  narrativeSummary: string | null;
  dismiss: (id: string) => Promise<void>;
}

export function useAmbientTimeline(
  localDate = todayLocalDate(),
  active = true,
): UseAmbientTimelineResult {
  const store = useMemo(() => getAmbientTimelineStore(), []);
  const [events, setEvents] = useState<AmbientTimelineEvent[]>([]);
  const [pendingTranscriptWindows, setPendingTranscriptWindows] = useState<AmbientCandidateWindow[]>([]);
  const [latestRawEvents, setLatestRawEvents] = useState<AmbientRawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeStatus, setStoreStatus] = useState<TimelineStoreStatus | null>(null);

  const load = useCallback(async () => {
    try {
      await store.init();
      const [rows, pending, latestRaw] = await Promise.all([
        store.listTimelineEvents(localDate, { visibleOnly: true, limit: 100 }),
        store.listCandidateWindows({
          localDate,
          windowType: "transcript_session",
          status: "pending",
          limit: 100,
        }),
        loadLatestRawEvents(store, localDate),
      ]);
      // 已进 pending 窗口的 transcript raw 事件不再重复当"最近原始事件"显示（对齐 dev）。
      const pendingRawTranscriptIds = new Set(
        pending.flatMap((w) =>
          w.rawRefs.filter((ref) => ref.sourceType === "transcript").map((ref) => ref.id),
        ),
      );
      setEvents(rows.filter(isDisplayableTimelineEvent));
      setPendingTranscriptWindows(pending);
      setLatestRawEvents(
        latestRaw.filter(
          (raw) => raw.sourceType !== "transcript" || !pendingRawTranscriptIds.has(raw.id),
        ),
      );
      setStoreStatus(store.status());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStoreStatus(store.status());
    } finally {
      setLoading(false);
    }
  }, [localDate, store]);

  const dismiss = useCallback(
    async (id: string) => {
      await store.dismissTimelineEvent(id);
      await load();
    },
    [load, store],
  );

  useEffect(() => {
    // 初次 load 与可见性解耦：总跑一次让 loading 收敛 + 数据就绪。否则页面以隐藏态
    // 挂载（keep-alive，active=false）时 load() 从不跑、loading 永远 true，首次切到
    // Ambient 会卡 spinner。切回不再 setLoading(true)（load 的 finally 收敛）免闪。
    void load();
    // 5s 轮询才按可见性 gate（省电/减热，WS8）：隐藏时停、保留 events → 切回即时显示。
    if (!active) return;
    const interval = setInterval(() => {
      probeCount("ambient.timelinePoll"); // __HEAT_PROBE__
      void load();
    }, 5_000);
    return () => clearInterval(interval);
  }, [load, active]);

  const narrativeSummary = useMemo(() => buildAmbientNarrativeSummary(events), [events]);

  return {
    events,
    pendingTranscriptWindows,
    latestRawEvents,
    localDate,
    loading,
    error,
    storeStatus,
    narrativeSummary,
    dismiss,
  };
}

/** 每源最新一条原始事件（dev loadLatestRawEvents 对应物）。 */
async function loadLatestRawEvents(
  store: Pick<AmbientTimelineStore, "listRawEvents">,
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
      const latest = await store.listRawEvents({ localDate, sourceType, order: "desc", limit: 1 });
      return latest[0] ?? null;
    }),
  );
  return rows.filter((row): row is AmbientRawEvent => Boolean(row));
}

// ── 占位符事件过滤（dev useAmbientTimeline.ts:214-241 逐字复制）：LLM 摘要
// 事件若时间戳非法或标题/正文是模型吐的占位符字面量，不进 UI。 ──

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
