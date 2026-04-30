#!/usr/bin/env node
/**
 * Smoke + fixture seeder for device ingest.
 *
 * Local dev assumes APIs is running with NODE_ENV=development, in which
 * case auth is off and every call routes to a single fixed local user.
 * No token, no Supabase, no Google login.
 *
 * Pipeline:
 *   1. POST /api/proactive/container/ensure   create the user's container
 *   2. POST /api/proactive/devices/register   register a wearable
 *   3. POST /api/proactive/devices/ingest * 3 push 30 mixed items
 *      (text moments, attention items, app inventory snapshot,
 *       ambient.image_chunk with base64 JPEG, ambient.audio_chunk with
 *       base64 Opus). Binaries are persisted under
 *       /app/data/media/<deviceId>/<YYYY-MM-DD>/<id>.<ext>.
 *
 * Usage:
 *   node scripts/smoke-device-ingest.mjs
 *
 * Optional:
 *   API_BASE=http://localhost:3000   override APIs base URL
 *   DEVICE_ID=<existing>             reuse a device (skips register)
 *   DEVICE_TOKEN=<token>             paired with DEVICE_ID
 *   SEED_COUNT=30                    total items
 */
import { randomUUID } from "node:crypto";

const API_BASE = (process.env.API_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const SEED_COUNT = Math.max(1, Math.min(200, Number(process.env.SEED_COUNT ?? 30)));

// 1x1 red JPEG and a 5-byte non-empty Opus blob — enough to round-trip.
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AAAAB/9k=";
const TINY_OPUS_B64 = Buffer.from([0xfc, 0xff, 0xfe, 0x00, 0x00]).toString("base64");

async function postJson(path, body, extraHeaders = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ensureContainer() {
  const data = await postJson("/api/proactive/container/ensure");
  console.log(`[smoke] container ${data.containerId?.slice(0, 12)}… status=${data.status}`);
}

async function registerDevice() {
  const deviceId = `omi-smoke-${randomUUID().slice(0, 8)}`;
  const data = await postJson("/api/proactive/devices/register", {
    deviceId,
    platform: "wearable",
    model: "omi_pendant_v1",
    displayName: "OMI Smoke Pendant",
    metadata: { firmware: "smoke-seed", paired_via: "smoke-script" },
  });
  return { deviceId: data.device.device_id, deviceToken: data.device_token };
}

function makeItems(deviceId, count) {
  const now = Date.now();
  const source = `device:${deviceId}`;
  const items = [];
  for (let i = 0; i < count; i++) {
    const occurred_at = new Date(now - i * 90_000).toISOString();
    const roll = i % 5;
    if (roll === 0) {
      items.push({
        id: randomUUID(), source,
        kind: "ambient.image_chunk",
        title: `frame #${i}`,
        summary: `omi 抓拍 ${i + 1}`,
        occurred_at,
        payload: {
          width: 640, height: 480, orientation: 1,
          mime: "image/jpeg",
          binary_b64: TINY_JPEG_B64,
        },
      });
    } else if (roll === 1) {
      items.push({
        id: randomUUID(), source,
        kind: "ambient.audio_chunk",
        title: `audio #${i}`,
        summary: `5s 音频片段 ${i + 1}`,
        occurred_at,
        payload: {
          duration_ms: 5000, sample_rate: 16000, codec_id: 21,
          mime: "audio/opus",
          binary_b64: TINY_OPUS_B64,
        },
      });
    } else if (roll === 2) {
      items.push({
        id: randomUUID(), source,
        kind: "moment",
        title: `moment ${i + 1}`,
        summary: `用户在桌前工作 (#${i})`,
        occurred_at,
        payload: { producer: "smoke-seed", emotion: "focused" },
        salience: 0.5, confidence: 0.85,
      });
    } else if (roll === 3) {
      items.push({
        id: randomUUID(), source,
        kind: "attention_item",
        title: `提醒 ${i + 1}`,
        summary: `今天还需要回复一封邮件 (#${i})`,
        occurred_at,
        payload: { producer: "smoke-seed", urgency: i % 2 ? "high" : "normal" },
        salience: 0.8, confidence: 0.9,
      });
    } else {
      items.push({
        id: randomUUID(), source,
        kind: "app_inventory_snapshot",
        title: `app inventory ${i + 1}`,
        summary: `本机当前安装的应用列表`,
        occurred_at,
        payload: {
          producer: "smoke-seed",
          apps: [
            { bundleId: "com.apple.Safari", appName: "Safari", version: "18.0" },
            { bundleId: "com.tencent.xin", appName: "微信", version: "8.0.49" },
            { bundleId: "com.slack.Slack", appName: "Slack", version: "4.40.0" },
          ],
        },
      });
    }
  }
  return items;
}

// PersonalSignal envelope: top-level array; deviceId comes from each
// signal's `source: "device:<id>"`. Auth still goes via the X-Device-*
// headers because that's how the APIs proxy resolves the user container.
async function ingestBatch(deviceId, deviceToken, items) {
  return postJson(
    "/api/proactive/devices/ingest",
    items,
    { "X-Device-Id": deviceId, "X-Device-Token": deviceToken },
  );
}

(async () => {
  console.log(`[smoke] target: ${API_BASE}`);

  await ensureContainer();

  let deviceId = process.env.DEVICE_ID ?? "";
  let deviceToken = process.env.DEVICE_TOKEN ?? "";
  if (!deviceId || !deviceToken) {
    const reg = await registerDevice();
    deviceId = reg.deviceId; deviceToken = reg.deviceToken;
    console.log(`[smoke] registered deviceId=${deviceId}`);
  } else {
    console.log(`[smoke] reusing deviceId=${deviceId}`);
  }

  const items = makeItems(deviceId, SEED_COUNT);
  console.log(`[smoke] seeding ${items.length} items in batches of 10…`);
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const result = await ingestBatch(deviceId, deviceToken, batch);
    console.log(`  batch ${Math.floor(i / 10) + 1}: accepted=${result.accepted} inserted=${result.inserted}`);
  }
  console.log(`\n[smoke] done. deviceId=${deviceId}`);
})().catch((err) => {
  console.error("[smoke] FAILED:", err.message ?? err);
  process.exit(1);
});
