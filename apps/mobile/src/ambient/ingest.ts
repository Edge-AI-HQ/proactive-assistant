/**
 * Ingest 上传(RN):**durable outbox**(expo-sqlite via core SqliteOutboxStore)+ 周期
 * flush POST /api/devices/ingest。app kill 不丢信号(此前是内存 buffer)。wire 协议同
 * web lib/devices.ts ingestSignals(X-Device 头、id 客户端生成);401 清凭证下轮重注册。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SqliteOutboxStore } from "@pin-ai/core";

import { ENV } from "../lib/env";
import { ensureDevice, clearDeviceCredentials, type DeviceCredentials } from "../lib/devices";
import { createExpoDatabase } from "../lib/sync/expo-database";
import type { PersonalSignalInput } from "./types";

const FLUSH_INTERVAL_MS = 30_000;
const PENDING_BATCH = 200;
const RETRY_BACKOFF_MS = 60_000;

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

export async function setUploadsLocked(value: boolean): Promise<void> {
  uploadsLocked = value;
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
  try {
    const records = await outbox.pending(PENDING_BATCH, Date.now(), owner, backendUrl);
    if (records.length === 0) return;
    const creds = await ensureDevice(owner);
    const res = await postBatch(creds, records.map((r) => r.item));
    const ids = records.map((r) => r.id);
    if (res.ok) {
      await outbox.markSynced(ids, Date.now(), owner, backendUrl);
      console.log(`[ambient] ingested ${ids.length} signals`);
    } else {
      // 401 = device token 失效:清凭证,下轮 ensureDevice 重注册换新 token。
      if (res.status === 401) await clearDeviceCredentials();
      await outbox.markFailed(ids, `ingest ${res.status}`, Date.now() + RETRY_BACKOFF_MS);
      console.warn(`[ambient] ingest failed ${res.status}, will retry`);
    }
  } catch (err) {
    // 网络等异常:不 markFailed(保 pending 下轮即重试,不累加 backoff)。
    console.warn("[ambient] flush failed:", err);
  } finally {
    flushing = false;
  }
}

export function startIngestLoop(userId: string): void {
  ownerUserId = userId;
  void AsyncStorage.getItem(UPLOADS_LOCKED_KEY).then((v) => {
    uploadsLocked = v === "1";
  });
  if (timer) return;
  timer = setInterval(() => void flushSignals(), FLUSH_INTERVAL_MS);
  void outbox.prune().catch(() => {}); // 启动清过期(synced 超 24h / pending 超 TTL)
}

export function stopIngestLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  void flushSignals();
}
