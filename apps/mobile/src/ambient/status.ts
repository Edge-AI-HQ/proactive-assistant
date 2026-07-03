/**
 * Ambient runtime 遥测状态（RN）—— web services/ambient AmbientRuntime.status()
 * 契约的 RN 对应物。SourceStatus / RuntimeStatus 形状与 web index.ts 一致，
 * AmbientSourceControlsPanel 同款消费。
 *
 * RN 架构差异（忠实映射，非抄错）：RN 是 durable outbox（信号直接进 expo-sqlite，
 * 无 web 的内存 buffer 阶段）→ bufferSize 恒 0、outboxMode 恒 "sqlite"、
 * flush = 立即 drain（把 outbox 推上网，web 的 flush 只是 buffer→outbox）。
 *
 * 数据来源分工：
 *  - 采集层（runtime.ts 的 ctx.onEvent / 源启停）记录 per-source lastEvent/count/error。
 *  - 上传层（ingest.ts 的 flushSignals）记录聚合 drain 遥测 + outboxPendingCount。
 *  - per-source running 不存这里，snapshot 时从 source.isStarted() 现读（即真相）。
 */

import { AMBIENT_SOURCE_KEYS, type AmbientSourceKey } from "./keys";

export interface SourceStatus {
  key: string;
  label: string;
  /** RN：该源当前是否在跑（snapshot 时 = source.isStarted()）。 */
  enabled: boolean;
  lastEvent: { ts: number; summary: string } | null;
  ingestedCount: number;
  lastError: string | null;
}

export interface RuntimeStatus {
  sources: SourceStatus[];
  bufferSize: number;
  outboxMode: "memory" | "sqlite";
  outboxPendingCount: number;
  totalIngested: number;
  totalIngestErrors: number;
  lastFlushTs: number | null;
  lastDrainTs: number | null;
  lastSuccessfulDrainTs: number | null;
  lastIngestError: string | null;
  uploadsLocked: boolean;
}

interface PerSourceTelemetry {
  lastEvent: { ts: number; summary: string } | null;
  ingestedCount: number;
  lastError: string | null;
}

interface Aggregate {
  outboxPendingCount: number;
  totalIngested: number;
  totalIngestErrors: number;
  lastFlushTs: number | null;
  lastDrainTs: number | null;
  lastSuccessfulDrainTs: number | null;
  lastIngestError: string | null;
  uploadsLocked: boolean;
}

const perSource = new Map<string, PerSourceTelemetry>();
const listeners = new Set<() => void>();
const agg: Aggregate = {
  outboxPendingCount: 0,
  totalIngested: 0,
  totalIngestErrors: 0,
  lastFlushTs: null,
  lastDrainTs: null,
  lastSuccessfulDrainTs: null,
  lastIngestError: null,
  uploadsLocked: false,
};

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ensure(key: string): PerSourceTelemetry {
  let s = perSource.get(key);
  if (!s) {
    s = { lastEvent: null, ingestedCount: 0, lastError: null };
    perSource.set(key, s);
  }
  return s;
}

export function notifyStatus(): void {
  for (const l of listeners) l();
}

export function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── 采集层（runtime）记录 ──

/**
 * 源捕获一条数据事件：刷新 lastEvent + 清错误。
 * 注意 ingestedCount **不在这里 +1**——对齐 web，计数只在 drain 确认上传后
 * 按 kind 归账（见 recordIngestedItems），lastEvent 是捕获即刷新、计数是送达才加。
 */
export function recordSourceEvent(key: string, summary: string): void {
  const s = ensure(key);
  s.lastEvent = { ts: Date.now(), summary };
  s.lastError = null;
  notifyStatus();
}

export function recordSourceError(key: string, error: string): void {
  ensure(key).lastError = error;
  notifyStatus();
}

export function clearSourceError(key: string): void {
  const s = perSource.get(key);
  if (s && s.lastError !== null) {
    s.lastError = null;
    notifyStatus();
  }
}

// ── 上传层（ingest）记录 ──

export function recordDrainAttempt(ts: number): void {
  agg.lastDrainTs = ts;
  agg.lastFlushTs = ts;
  notifyStatus();
}

export function recordDrainSuccess(syncedCount: number, ts: number): void {
  agg.totalIngested += syncedCount;
  agg.lastSuccessfulDrainTs = ts;
  agg.lastIngestError = null;
  notifyStatus();
}

export function recordDrainError(error: string): void {
  agg.totalIngestErrors += 1;
  agg.lastIngestError = error;
  notifyStatus();
}

/**
 * drain 成功但有 retryable 条目保留在队里：错误计数 +1、不设 lastIngestError
 * （= dev runtime.drain 的 `totalIngestErrors += result.failed > 0 ? 1 : 0` +
 * scheduler 成功后 lastError=null 的组合语义）。
 */
export function recordDrainRetryable(): void {
  agg.totalIngestErrors += 1;
  notifyStatus();
}

// 源 → 主信号 kind（逐字对齐 web index.ts SOURCE_TO_KIND；RN 各源 emit 同一套 kind）。
const SOURCE_TO_KIND: Record<AmbientSourceKey, string> = {
  sound_classifier: "device.sound_classification",
  visit: "device.visit",
  activity: "device.activity",
  location: "device.location",
  health: "health.observation",
  calendar: "device.calendar_event",
  focus: "device.focus_state",
  audio_route: "device.audio_route",
  device_state: "device.device_state",
};

/**
 * drain 确认上传成功的条目 → 按 kind 归账到对应源的 ingestedCount（= web
 * recordIngestedItems 的对应物）。sound_classifier 特例：声音分类 + 会话摘要
 * （session_summary）两种 kind 都算它（同 web）。只在 flushSignals 成功后调。
 */
export function recordIngestedItems(items: ReadonlyArray<{ kind: string }>): void {
  if (items.length === 0) return;
  const byKind = new Map<string, number>();
  for (const it of items) byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
  const soundCount =
    (byKind.get("device.sound_classification") ?? 0) + (byKind.get("session_summary") ?? 0);
  let changed = false;
  for (const key of AMBIENT_SOURCE_KEYS) {
    const c = key === "sound_classifier" ? soundCount : (byKind.get(SOURCE_TO_KIND[key]) ?? 0);
    if (c > 0) {
      ensure(key).ingestedCount += c;
      changed = true;
    }
  }
  if (changed) notifyStatus();
}

/** 采集→管线蒸馏失败时记 lastIngestError（= dev runtime.ingestLocalSignal 的
 *  catch 分支；不计入 totalIngestErrors——那是 drain 维度的计数）。 */
export function setLastIngestError(error: string): void {
  agg.lastIngestError = error;
  notifyStatus();
}

export function setOutboxPending(n: number): void {
  if (agg.outboxPendingCount !== n) {
    agg.outboxPendingCount = n;
    notifyStatus();
  }
}

export function setUploadsLockedStatus(value: boolean): void {
  if (agg.uploadsLocked !== value) {
    agg.uploadsLocked = value;
    notifyStatus();
  }
}

// ── snapshot 读取（runtime.ts 组装 sources 部分后返回完整 RuntimeStatus）──

export function getPerSourceTelemetry(key: string): PerSourceTelemetry | undefined {
  return perSource.get(key);
}

export function getAggregate(): Readonly<Aggregate> {
  return agg;
}
