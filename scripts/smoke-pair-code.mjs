#!/usr/bin/env node
/**
 * End-to-end smoke for the Pair Code flow.
 * Simulates two parties (device + user) against the same APIs server.
 *
 *   device   POST /devices/pair-code/request
 *      ↓
 *   device   GET  /devices/pair-code/poll → 'pending'
 *   user     POST /devices/pair-code/claim   (Web side)
 *   device   GET  /devices/pair-code/poll → 'claimed' + token
 *   device   GET  /devices/pair-code/poll → 'claimed' (token cleared)
 *   device   POST /devices/ingest with the pair-issued token
 *   user     GET  /signals?deviceId=… verifies the data landed
 *
 * Local dev assumes APIs is running with NODE_ENV=development (auth off).
 *
 * Usage:
 *   node scripts/smoke-pair-code.mjs
 */
import { randomUUID } from "node:crypto";

const API_BASE = (process.env.API_BASE ?? "http://localhost:3000").replace(/\/$/, "");

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

(async () => {
  console.log(`[pair-smoke] target: ${API_BASE}`);

  // Make sure the user container exists (otherwise ingest 502s on cold start).
  const ensure = await postJson("/api/proactive/container/ensure");
  console.log(`[pair-smoke] container ${ensure.containerId?.slice(0, 12)}… status=${ensure.status}`);

  // 1. Device asks for a code.
  const req = await postJson("/api/proactive/devices/pair-code/request", {
    deviceClass: "wearable",
    model: "smoke_pendant_v1",
  });
  console.log(`[pair-smoke] 1. requested code=${req.code} (poll every ${req.poll_interval}s, expires in ${req.expires_in}s)`);

  // 2. Device polls — should be pending right after request.
  const p1 = await getJson(`/api/proactive/devices/pair-code/poll?code=${req.code}`);
  if (p1.status !== "pending") throw new Error(`expected 'pending', got '${p1.status}'`);
  console.log(`[pair-smoke] 2. poll #1 → ${p1.status}`);

  // 3. User on the Web side claims the code.
  const claim = await postJson("/api/proactive/devices/pair-code/claim", {
    code: req.code,
    displayName: "Smoke Pendant",
    model: "smoke_pendant_v1",
  });
  if (!claim.device_id || !claim.device_token) throw new Error(`claim missing token/device_id: ${JSON.stringify(claim)}`);
  console.log(`[pair-smoke] 3. user claimed → device_id=${claim.device_id.slice(0, 12)}…`);

  // 4. Device's next poll picks up the token (one-shot).
  const p2 = await getJson(`/api/proactive/devices/pair-code/poll?code=${req.code}`);
  if (p2.status !== "claimed") throw new Error(`expected 'claimed', got '${p2.status}'`);
  if (p2.device_token !== claim.device_token) throw new Error("token mismatch between claim and first poll");
  console.log(`[pair-smoke] 4. poll #2 → claimed + token (${p2.device_token.slice(0, 8)}…)`);

  // 5. Subsequent poll returns claimed without the token (already consumed).
  const p3 = await getJson(`/api/proactive/devices/pair-code/poll?code=${req.code}`);
  if (p3.status !== "claimed") throw new Error(`expected 'claimed', got '${p3.status}'`);
  if (p3.device_token) throw new Error("token leaked on second poll — should be one-shot");
  console.log(`[pair-smoke] 5. poll #3 → claimed (token cleared,as expected)`);

  // 6. Device uses the issued token to ingest signals via the new envelope.
  const items = [
    {
      id: randomUUID(),
      source: `device:${claim.device_id}`,
      kind: "moment",
      occurred_at: new Date().toISOString(),
      title: "first signal after pairing",
      summary: "device bootstrapped via pair-code",
      payload: { producer: "smoke-pair-code" },
    },
    {
      id: randomUUID(),
      source: `device:${claim.device_id}`,
      kind: "ring.heart_rate",
      occurred_at: new Date().toISOString(),
      title: "hr 72",
      summary: "first measurement",
      payload: { bpm: 72, hrv: 35 },
    },
  ];
  const ingestRes = await postJson("/api/proactive/devices/ingest", items, {
    "X-Device-Id": claim.device_id,
    "X-Device-Token": claim.device_token,
  });
  if (ingestRes.inserted !== 2) throw new Error(`expected 2 inserted, got ${ingestRes.inserted}`);
  console.log(`[pair-smoke] 6. ingest with paired token → accepted=${ingestRes.accepted} inserted=${ingestRes.inserted}`);

  // 7. User-side query confirms the signals are queryable per-device.
  const list = await getJson(`/api/proxy/signals?deviceId=${claim.device_id}&status=all&limit=5`);
  if (list.signals.length !== 2) throw new Error(`expected 2 signals, got ${list.signals.length}`);
  console.log(`[pair-smoke] 7. timeline read → total=${list.total} kinds=[${list.signals.map((s) => s.kind).join(", ")}]`);

  // 8. Negative paths: claim a second time, claim non-existent code.
  try {
    await postJson("/api/proactive/devices/pair-code/claim", { code: req.code });
    throw new Error("re-claim should have failed but didn't");
  } catch (e) {
    if (!String(e.message).includes("409")) throw new Error(`re-claim wrong status: ${e.message}`);
  }
  console.log(`[pair-smoke] 8a. re-claim same code → 409 (correct)`);

  try {
    await postJson("/api/proactive/devices/pair-code/claim", { code: "NOPENO" });
    throw new Error("nonexistent claim should have failed but didn't");
  } catch (e) {
    if (!String(e.message).includes("404")) throw new Error(`bad claim wrong status: ${e.message}`);
  }
  console.log(`[pair-smoke] 8b. claim non-existent code → 404 (correct)`);

  console.log(`\n[pair-smoke] ✓ all checks passed. device_id=${claim.device_id}`);
})().catch((err) => {
  console.error("[pair-smoke] FAILED:", err.message ?? err);
  process.exit(1);
});
