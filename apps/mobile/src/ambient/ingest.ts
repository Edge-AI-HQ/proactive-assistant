/**
 * Ingest 上传(RN):**durable outbox**(expo-sqlite via core SqliteOutboxStore)+ 周期
 * flush POST /api/devices/ingest。app kill 不丢信号(此前是内存 buffer)。wire 协议同
 * web lib/devices.ts ingestSignals(X-Device 头、id 客户端生成);401 清凭证下轮重注册。
 *
 * 上传形态对齐 dev sync-scheduler：
 *  - flush 前按 SYNCABLE_AMBIENT_KINDS 白名单过滤（ambient.timeline_event /
 *    ambient.candidate_window / health.observation），local-only 源信号直接
 *    markSynced 出队 + 警告——服务端只消费蒸馏后的管线产物。
 *  - 服务端 V3 per-item results 三桶分类（core bucketRecords）：settled 出队、
 *    retryable 保留 + 指数退避（2^attempt*5s 封顶 15min），rejected/parse_failed
 *    永久出队并记日志。
 *  - drain 成功后 markTimelineEventsSynced 把本地 timeline 事件标记已同步。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  SYNCABLE_AMBIENT_KINDS,
  SqliteOutboxStore,
  bucketRecords,
  localEventIdsFromSignals,
  retryDelayMs,
  type IngestResult,
} from "@pin-ai/core";

import { ENV } from "../lib/env";
import { ensureDevice, clearDeviceCredentials, type DeviceCredentials } from "../lib/devices";
import { createExpoDatabase } from "../lib/sync/expo-database";
import { getAmbientTimelineStore } from "./timeline/store";
import type { PersonalSignalInput } from "./types";
import {
  describeError,
  recordDrainAttempt,
  recordDrainError,
  recordDrainRetryable,
  recordDrainSuccess,
  recordIngestedItems,
  setOutboxPending,
  setUploadsLockedStatus,
} from "./status";

const FLUSH_INTERVAL_MS = 30_000;
const PENDING_BATCH = 200;
const MAX_RETRY_DELAY_MS = 15 * 60_000; // dev sync-scheduler maxRetryDelayMs

// durable:落 expo-sqlite,app kill / 断连后重启仍能续传(replaced 内存 buffer)。
const outbox = new SqliteOutboxStore(createExpoDatabase("ambient"));
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let ownerUserId: string | null = null;

// Upload soft-lock（对齐 web sync-scheduler.uploadsLocked / pin.ambient.uploadsLocked）：
// 锁上时继续往 durable outbox 攒信号，但不 POST（暂停 sync、保留本地采集）；解锁后补传。
const UPLOADS_LOCKED_KEY = "pinai:ambient-uploads-locked";
let uploadsLocked = false;

export async function isUploadsLocked(): Promise<boolean> {
  return (await AsyncStorage.getItem(UPLOADS_LOCKED_KEY)) === "1";
}

/** 同步读锁镜像（scheduled summary 的 shouldUseCloud 中途复查用，= dev
 *  scheduler.isUploadsLocked() 的同步语义）。 */
export function uploadsLockedSnapshot(): boolean {
  return uploadsLocked;
}

export async function setUploadsLocked(value: boolean): Promise<void> {
  uploadsLocked = value;
  setUploadsLockedStatus(value);
  await AsyncStorage.setItem(UPLOADS_LOCKED_KEY, value ? "1" : "0");
}

export function pushSignal(item: PersonalSignalInput): void {
  void outbox.enqueue([item]).catch((err) => console.warn("[ambient] enqueue failed:", err));
}

async function postBatch(creds: DeviceCredentials, items: PersonalSignalInput[]) {
  const now = new Date().toISOString();
  const wire = items.map((it) => ({
    id: it.id,
    source: it.source ?? `device:${creds.deviceId}`,
    kind: it.kind,
    ...(it.sync_mode ? { sync_mode: it.sync_mode } : {}),
    title: it.title,
    summary: it.summary,
    payload: it.payload ?? {},
    occurred_at: it.occurred_at ?? now,
    ...(it.available_at ? { available_at: it.available_at } : {}),
    ...(it.expires_at ? { expires_at: it.expires_at } : {}),
    ...(typeof it.salience === "number" ? { salience: it.salience } : {}),
    ...(typeof it.confidence === "number" ? { confidence: it.confidence } : {}),
    ...(it.dedupe_key ? { dedupe_key: it.dedupe_key } : {}),
  }));
  return fetch(`${ENV.pinApiUrl}/api/devices/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": creds.deviceId,
      "X-Device-Token": creds.deviceToken,
    },
    body: JSON.stringify(wire),
  });
}

export async function flushSignals(): Promise<void> {
  if (flushing || !ownerUserId || uploadsLocked) return;
  flushing = true;
  const owner = ownerUserId;
  const backendUrl = ENV.pinApiUrl;
  recordDrainAttempt(Date.now());
  let records: Awaited<ReturnType<typeof outbox.pending>> = [];
  try {
    await outbox.prune(Date.now());
    const pendingRecords = await outbox.pending(PENDING_BATCH, Date.now(), owner, backendUrl);
    // dev sync-scheduler:95-112 —— 只同步蒸馏产物；raw 源信号是 local-only，
    // 出队（markSynced）并警告，绝不上传。
    records = pendingRecords.filter((row) => SYNCABLE_AMBIENT_KINDS.has(row.item.kind));
    const localOnlyRecords = pendingRecords.filter(
      (row) => !SYNCABLE_AMBIENT_KINDS.has(row.item.kind),
    );
    if (localOnlyRecords.length > 0) {
      console.warn("[ambient] dropping local-only source items before sync", {
        count: localOnlyRecords.length,
        kinds: Array.from(new Set(localOnlyRecords.map((row) => row.item.kind))),
      });
      await outbox.markSynced(
        localOnlyRecords.map((row) => row.id),
        Date.now(),
        owner,
        backendUrl,
      );
    }
    if (records.length === 0) return;
    const creds = await ensureDevice(owner);
    const res = await postBatch(creds, records.map((r) => r.item));
    if (!res.ok) {
      // 401 = device token 失效:清凭证,下轮 ensureDevice 重注册换新 token。
      if (res.status === 401) await clearDeviceCredentials();
      throw new Error(`ingest ${res.status}`);
    }
    const stats = (await res.json()) as IngestResult;
    // V3 per-item 三桶（dev sync-scheduler:129-157）：settled 出队；retryable
    // 保留 + 指数退避；rejected/parse_failed 永久出队 + 记日志。
    const { settledIds, retryableIds, rejectedDetails } = bucketRecords(records, stats);
    if (rejectedDetails.length > 0) {
      console.warn("[ambient] dropping items as permanently rejected", {
        count: rejectedDetails.length,
        samples: rejectedDetails.slice(0, 5),
      });
    }
    await outbox.markSynced(settledIds, Date.now(), owner, backendUrl);
    if (retryableIds.length > 0) {
      console.warn("[ambient] keeping items for retry", {
        attempted: records.length,
        settled: settledIds.length,
        retryable: retryableIds.length,
      });
      await outbox.markFailed(
        retryableIds,
        "retryable_failed or unacknowledged",
        Date.now() + retryDelayMs(records, MAX_RETRY_DELAY_MS),
      );
      recordDrainRetryable();
    }
    const settledIdSet = new Set(settledIds);
    const syncedItems = records
      .filter((row) => settledIdSet.has(row.id))
      .map((row) => row.item);
    recordDrainSuccess(stats.inserted, Date.now());
    recordIngestedItems(syncedItems); // 按 kind 归账到对应源（同 web）
    await markTimelineEventsSynced(syncedItems);
    console.log(`[ambient] ingested ${settledIds.length} signals (${stats.inserted} inserted)`);
  } catch (err) {
    // HTTP 非 2xx / 网络异常：整批 markFailed + 指数退避（dev sync-scheduler:174-189）。
    const message = describeError(err);
    if (records.length > 0) {
      const nextRetryAt = Date.now() + retryDelayMs(records, MAX_RETRY_DELAY_MS);
      await outbox
        .markFailed(records.map((row) => row.id), message, nextRetryAt)
        .catch(() => {});
      console.warn("[ambient] outbox drain failed", {
        attempted: records.length,
        error: message,
        nextRetryAt: new Date(nextRetryAt).toISOString(),
      });
    } else {
      console.warn("[ambient] flush failed:", err);
    }
    recordDrainError(message);
  } finally {
    flushing = false;
    void refreshOutboxCount();
  }
}

/** drain 出队成功的 timeline 事件 → 本地 store 标记已同步（dev runtime
 *  markTimelineEventsSynced:393-404）。 */
async function markTimelineEventsSynced(items: PersonalSignalInput[]): Promise<void> {
  const localEventIds = localEventIdsFromSignals(items);
  if (localEventIds.length === 0) return;
  try {
    await getAmbientTimelineStore().markTimelineEventsSynced(localEventIds);
  } catch (err) {
    console.warn("[ambient] markTimelineEventsSynced failed:", err);
  }
}

export function startIngestLoop(userId: string): void {
  ownerUserId = userId;
  void AsyncStorage.getItem(UPLOADS_LOCKED_KEY).then((v) => {
    uploadsLocked = v === "1";
    setUploadsLockedStatus(uploadsLocked);
  });
  void refreshOutboxCount();
  if (timer) return;
  timer = setInterval(() => void flushSignals(), FLUSH_INTERVAL_MS);
  void outbox.prune().catch(() => {}); // 启动清过期(synced 超 24h / pending 超 TTL)
}

export function stopIngestLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  void flushSignals();
}

/** 刷新 outboxPendingCount 到遥测仓（reconcile / flush 后 + 每轮 drain 末调）。 */
export async function refreshOutboxCount(): Promise<void> {
  if (!ownerUserId) {
    setOutboxPending(0);
    return;
  }
  try {
    setOutboxPending(await outbox.count(ownerUserId, ENV.pinApiUrl));
  } catch {
    /* count best-effort */
  }
}
