/**
 * End-to-end HTTP test: boot a real http.Server, wrap handleDevices() as the
 * request handler, and POST the exact JSON shape the Android client sends
 * (MobileSyncConfig.kt / MOBILE_ITEMS_INGEST_PATH = "/api/devices/ingest").
 * Asserts the response envelope and that rows landed in the v3 stores.
 *
 * This exercises the v3-direct path end-to-end: no more mobile_items.db,
 * no more mirror hop — POST → personal_signals + raw.db in one shot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleDevices } from "./devices.ts";
import { listPersonalSignals, resetDbForTests } from "../db.ts";
import { listDeviceApps, listDeviceContacts, resetRawDbForTests } from "../raw-db.ts";

function withTempHome(fn: (baseUrl: string) => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-http-"));
    process.env.OPENCLAW_HOME = home;
    resetDbForTests();
    resetRawDbForTests();

    const handler = handleDevices();
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const ctx = {
        api: {} as never,
        url,
        req,
        res,
        subpath: url.pathname,
      };
      // Route prefix stripped upstream in the real server; here we match
      // the exact subpath the handler expects.
      const handled = await handler(ctx as never);
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not_found" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      resetDbForTests();
      resetRawDbForTests();
      if (previous === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("POST /devices/ingest — moment + attention_item land in personal_signals", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/devices/ingest`, {
    deviceId: "pixel-e2e",
    items: [
      {
        id: "mob-evt-1",
        itemType: "moment",
        title: "home → office",
        summary: "8:00 出发 25 分钟到公司",
        payload: { from: "place:home", to: "place:office", durationMin: 25 },
        salience: 0.65,
        confidence: 0.7,
        dedupeKey: "device:loc:home_to_office:2026-04-23",
        occurredAt: "2026-04-23T08:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z",
      },
      {
        id: "mob-evt-2",
        itemType: "attention_item",
        title: "Delivery update",
        summary: "Shop notification needs action",
        salience: 0.7,
        confidence: 0.6,
        dedupeKey: "notification:com.shop:1",
        occurredAt: "2026-04-23T08:05:00Z",
      },
    ],
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 2);
  assert.equal(body.inserted, 2);
  assert.equal(body.ignored, 0);

  const signals = await listPersonalSignals({ status: "open" });
  assert.equal(signals.length, 2);
  const byKind = Object.fromEntries(signals.map((s) => [s.kind, s]));
  assert.ok(byKind["moment"]);
  assert.ok(byKind["attention_item"]);
  assert.equal(byKind["moment"]!.device_id, "pixel-e2e");
  assert.equal(byKind["moment"]!.source, "device");
  assert.equal(byKind["moment"]!.salience, 0.65);
  assert.equal(byKind["moment"]!.occurred_at, "2026-04-23T08:00:00.000Z");
}));

test("POST /devices/ingest — app inventory snapshot also fans out to raw.db", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/devices/ingest`, {
    deviceId: "pixel-apps",
    items: [{
      id: "snap-apps-1",
      itemType: "app_inventory_bootstrap",
      title: "Apps installed",
      summary: "3 apps",
      salience: 0.5,
      occurredAt: "2026-04-23T08:00:00Z",
      payload: {
        apps: [
          { bundleId: "com.tencent.wechat", appName: "WeChat" },
          { bundleId: "com.robinhood.android", appName: "Robinhood" },
          { bundleId: "com.spotify.music", appName: "Spotify" },
        ],
      },
    }],
  });

  assert.equal(status, 200);
  assert.equal(body.inserted, 1);

  // personal_signals: the high-level "snapshot happened" event
  const signals = await listPersonalSignals({ status: "open" });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.kind, "app_inventory_bootstrap");

  // raw.db.device_apps_snapshot: tabular per-app rows
  const apps = listDeviceApps({ deviceId: "pixel-apps", latestSnapshotOnly: true });
  assert.equal(apps.length, 3);
  const names = apps.map((a) => a.app_name).sort();
  assert.deepEqual(names, ["Robinhood", "Spotify", "WeChat"]);
}));

test("POST /devices/ingest — contact snapshot fans out + is searchable", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/devices/ingest`, {
    deviceId: "iphone-contacts",
    items: [{
      id: "snap-contacts-1",
      itemType: "contact_directory_snapshot",
      title: "Contacts",
      summary: "2 contacts",
      occurredAt: "2026-04-23T08:00:00Z",
      payload: {
        contacts: [
          { displayName: "妈妈", phones: ["+8613800000000"] },
          { displayName: "Alice Chen", emails: ["alice@example.com"] },
        ],
      },
    }],
  });

  assert.equal(status, 200);
  assert.equal(body.inserted, 1);

  const contacts = listDeviceContacts({ deviceId: "iphone-contacts", latestSnapshotOnly: true });
  assert.equal(contacts.length, 2);

  const searched = listDeviceContacts({
    deviceId: "iphone-contacts", latestSnapshotOnly: true, search: "妈",
  });
  assert.equal(searched.length, 1);
  assert.equal(searched[0]!.display_name, "妈妈");
}));

test("POST /devices/ingest — repost with same dedupeKey is idempotent", withTempHome(async (baseUrl) => {
  const payload = {
    deviceId: "dedupe-dev",
    items: [{
      id: "dedup-1",
      itemType: "moment",
      title: "once",
      summary: "once only",
      dedupeKey: "dedupe:k:1",
      occurredAt: "2026-04-23T08:00:00Z",
    }],
  };
  const first = await postJson(`${baseUrl}/devices/ingest`, payload);
  assert.equal(first.body.inserted, 1);

  const second = await postJson(`${baseUrl}/devices/ingest`, {
    ...payload,
    items: [{ ...payload.items[0]!, id: "dedup-2", title: "twice", summary: "twice only" }],
  });
  assert.equal(second.body.accepted, 1);
  assert.equal(second.body.inserted, 0);
  assert.equal(second.body.ignored, 1);

  const signals = await listPersonalSignals({ status: "open" });
  assert.equal(signals.length, 1, "dedupe key must prevent a second row");
  assert.equal(signals[0]!.title, "once", "first write wins — idempotent");
}));

test("POST /devices/ingest — missing deviceId → HTTP 400", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/devices/ingest`, {
    items: [{ id: "x", itemType: "moment", title: "t", summary: "s" }],
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
}));

test("POST /devices/ingest — empty items array → accepted=0, no rows", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/devices/ingest`, {
    deviceId: "empty-dev",
    items: [],
  });
  assert.equal(status, 200);
  assert.equal(body.accepted, 0);
  assert.equal(body.inserted, 0);
  assert.deepEqual(body.results, []);
  const signals = await listPersonalSignals({ status: "open" });
  assert.equal(signals.length, 0);
}));

test("POST /devices/ingest — ambient image_chunk persists JPEG to FS, signal points to file_path",
  withTempHome(async (baseUrl) => {
    const home = process.env.OPENCLAW_HOME!;
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);
    const { status, body } = await postJson(`${baseUrl}/devices/ingest`, {
      deviceId: "omi-pendant-1",
      items: [{
        id: "frame-1",
        kind: "ambient.image_chunk",
        title: "frame",
        summary: "1 frame from omi pendant",
        occurredAt: "2026-04-28T12:00:00Z",
        payload: {
          width: 640, height: 480, orientation: 1,
          binary_b64: fakeJpeg.toString("base64"),
        },
      }],
    });
    assert.equal(status, 200);
    assert.equal(body.accepted, 1);
    assert.equal(body.inserted, 1);

    const signals = await listPersonalSignals({ kind: "ambient.image_chunk" });
    assert.equal(signals.length, 1);
    const filePath = (signals[0]!.payload as { file_path?: string; binary_b64?: string }).file_path;
    assert.ok(filePath?.startsWith("media/omi-pendant-1/2026-04-28/"), `path: ${filePath}`);
    // base64 should be stripped from the payload — only the path remains.
    assert.equal((signals[0]!.payload as { binary_b64?: string }).binary_b64, undefined);

    const onDisk = fs.readFileSync(path.join(home, "data", filePath!));
    assert.deepEqual(onDisk, fakeJpeg);
  }),
);

test("GET /devices/media/<path> — serves the JPEG that ingest persisted",
  withTempHome(async (baseUrl) => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb, 0xcc]);
    const ingestRes = await postJson(`${baseUrl}/devices/ingest`, {
      deviceId: "omi-3",
      items: [{
        id: "frame-getme",
        kind: "ambient.image_chunk",
        title: "frame", summary: "served",
        occurredAt: "2026-04-28T00:00:00Z",
        payload: { width: 1, height: 1, orientation: 0, binary_b64: fakeJpeg.toString("base64") },
      }],
    });
    assert.equal(ingestRes.status, 200);

    const signals = await listPersonalSignals({ kind: "ambient.image_chunk" });
    const filePath = (signals[0]!.payload as { file_path?: string }).file_path!;

    // Now serve it back.
    const res = await fetch(`${baseUrl}/devices/media/${filePath}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, fakeJpeg);
  }),
);

test("GET /devices/media — rejects paths that don't start with media/",
  withTempHome(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/devices/media/etc/passwd`);
    assert.equal(res.status, 400);
  }),
);

test("POST /devices/ingest — PersonalSignal envelope: top-level array + envelope `source`",
  withTempHome(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/devices/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          id: "e2e-personal-signal-1",
          source: "device:omi-x42",
          kind: "moment",
          occurred_at: "2026-04-29T10:00:00Z",
          title: "envelope test",
          summary: "PersonalSignal envelope smoke",
          payload: { foo: "bar" },
        },
        {
          id: "e2e-personal-signal-2",
          source: "device:ring-y91",     // different device in same batch
          kind: "ring.heart_rate",
          occurred_at: "2026-04-29T10:00:05Z",
          title: "hr sample",
          summary: "72 bpm",
          payload: { bpm: 72 },
        },
      ]),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, 2);
    assert.equal(body.inserted, 2);

    // Different deviceIds means each ended up routed separately.
    const omi = await listPersonalSignals({ deviceId: "omi-x42" });
    const ring = await listPersonalSignals({ deviceId: "ring-y91" });
    assert.equal(omi.length, 1);
    assert.equal(ring.length, 1);
    assert.equal(omi[0]!.kind, "moment");
    assert.equal(ring[0]!.kind, "ring.heart_rate");
  }),
);

test("POST /devices/ingest — snake_case `occurred_at` / `dedupe_key` accepted",
  withTempHome(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/devices/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          id: "snake-case-1",
          source: "device:dev-snake",
          kind: "moment",
          occurred_at: "2026-04-29T11:00:00Z",
          title: "snake-case",
          summary: "ok",
          dedupe_key: "snake:1",
          payload: {},
        },
      ]),
    });
    assert.equal(res.status, 200);
    const signals = await listPersonalSignals({ deviceId: "dev-snake" });
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.dedupe_key, "snake:1");
    assert.equal(signals[0]!.occurred_at, "2026-04-29T11:00:00.000Z");
  }),
);

test("POST /devices/ingest — `kind` field preferred over legacy `itemType`",
  withTempHome(async (baseUrl) => {
    const { status } = await postJson(`${baseUrl}/devices/ingest`, {
      deviceId: "omi-2",
      items: [{
        id: "k1",
        kind: "moment",          // new clients send `kind`
        itemType: "should_lose", // ignored when kind is present
        title: "t", summary: "s",
      }],
    });
    assert.equal(status, 200);
    const signals = await listPersonalSignals({});
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.kind, "moment");
  }),
);
