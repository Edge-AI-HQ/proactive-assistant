/**
 * RN ambient timeline hook —— dev useAmbientTimeline 的精简对应物。
 * 读本地 SqliteTimelineStore（= dev 架构），产出当天「可见」的 AmbientTimelineEvent +
 * 叙事摘要（core buildAmbientNarrativeSummary，纯模板）。
 *
 * 现状：RN 的 ingest 只写上传 outbox（不写 timeline store）、端侧 LLM(llama) 未接 →
 * 本地 store 现为空 → events 恒空 → UI 显示 dev 同款空卡「No local timeline events yet」。
 * 等 llama + ingest→store 落地后，这里再补：① 轮询拾取新生成事件；② refreshTimeline 触发
 * 端侧生成；③ latestRawEvents / pendingTranscriptWindows（dev 也一起并进时间线）。
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
} from "@pin-ai/core";

import { getAmbientTimelineStore } from "../ambient/timeline";

export interface UseAmbientTimelineResult {
  events: AmbientTimelineEvent[];
  /** 待端侧摘要的转写窗口（进 timeline 显示，对齐 dev）。 */
  pendingTranscriptWindows: AmbientCandidateWindow[];
  /** 每源最新一条原始事件（缺 LLM 摘要时 timeline 也有内容，对齐 dev）。 */
  latestRawEvents: AmbientRawEvent[];
  localDate: string;
  loading: boolean;
  error: string | null;
  /** 当天叙事摘要（<2 条可见事件时为 null，对齐 dev）。 */
  narrativeSummary: string | null;
  dismiss: (id: string) => Promise<void>;
}

export function useAmbientTimeline(localDate = todayLocalDate()): UseAmbientTimelineResult {
  const store = useMemo(() => getAmbientTimelineStore(), []);
  const [events, setEvents] = useState<AmbientTimelineEvent[]>([]);
  const [pendingTranscriptWindows, setPendingTranscriptWindows] = useState<AmbientCandidateWindow[]>([]);
  const [latestRawEvents, setLatestRawEvents] = useState<AmbientRawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setEvents(rows);
      setPendingTranscriptWindows(pending);
      setLatestRawEvents(
        latestRaw.filter(
          (raw) => raw.sourceType !== "transcript" || !pendingRawTranscriptIds.has(raw.id),
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    setLoading(true);
    void load();
    // store 随采集持续写入 → 5s 轮询拾取新数据（对齐 dev）。
    const interval = setInterval(() => void load(), 5_000);
    return () => clearInterval(interval);
  }, [load]);

  const narrativeSummary = useMemo(() => buildAmbientNarrativeSummary(events), [events]);

  return {
    events,
    pendingTranscriptWindows,
    latestRawEvents,
    localDate,
    loading,
    error,
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
