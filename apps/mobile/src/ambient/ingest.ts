/**
 * Ingest 上传（RN）：buffer + 周期 flush POST /api/devices/ingest——
 * 与 web lib/devices.ts ingestSignals 同 wire 协议（X-Device 头、401 清
 * 凭证重注册重试、id 客户端生成）。
 *
 * MVP 为内存 buffer（flush 失败保留下轮重试；app 被杀丢未传批次——
 * durable outbox 接 DatabasePort 是后续刀，web 的 sqlite outbox 同语义）。
 */
import { ENV } from "../lib/env";
import { ensureDevice, type DeviceCredentials } from "../lib/devices";
import type { PersonalSignalInput } from "./types";

const FLUSH_INTERVAL_MS = 30_000;
const MAX_BUFFER = 500;

let buffer: PersonalSignalInput[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let ownerUserId: string | null = null;

export function pushSignal(item: PersonalSignalInput): void {
  buffer.push({ ...item, id: item.id ?? crypto.randomUUID() });
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
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
  if (flushing || buffer.length === 0 || !ownerUserId) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    const creds = await ensureDevice(ownerUserId);
    const res = await postBatch(creds, batch);
    if (!res.ok) throw new Error(`ingest failed: ${res.status}`);
    console.log(`[ambient] ingested ${batch.length} signals`);
  } catch (err) {
    // 失败整批放回（保序），下轮重试。
    buffer = [...batch, ...buffer].slice(-MAX_BUFFER);
    console.warn("[ambient] flush failed (kept in buffer):", err);
  } finally {
    flushing = false;
  }
}

export function startIngestLoop(userId: string): void {
  ownerUserId = userId;
  if (timer) return;
  timer = setInterval(() => void flushSignals(), FLUSH_INTERVAL_MS);
}

export function stopIngestLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  void flushSignals();
}
