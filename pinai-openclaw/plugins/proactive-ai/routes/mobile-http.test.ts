/**
 * End-to-end HTTP test: boot a real http.Server, wrap handleMobile() as the
 * request handler, and POST the exact JSON shape the Android client sends
 * (MobileSyncConfig.kt / MOBILE_ITEMS_INGEST_PATH = "/api/mobile/items/ingest").
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

import { handleMobile } from "./mobile.ts";
import { listPersonalSignals, resetDbForTests } from "../db.ts";
import { listDeviceApps, listDeviceContacts, resetRawDbForTests } from "../raw-db.ts";

function withTempHome(fn: (baseUrl: string) => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-http-"));
    process.env.OPENCLAW_HOME = home;
    resetDbForTests();
    resetRawDbForTests();

    const handler = handleMobile();
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

test("POST /mobile/items/ingest — moment + attention_item land in personal_signals", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/mobile/items/ingest`, {
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

test("POST /mobile/items/ingest — app inventory snapshot also fans out to raw.db", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/mobile/items/ingest`, {
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

test("POST /mobile/items/ingest — contact snapshot fans out + is searchable", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/mobile/items/ingest`, {
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

test("POST /mobile/items/ingest — repost with same dedupeKey is idempotent", withTempHome(async (baseUrl) => {
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
  const first = await postJson(`${baseUrl}/mobile/items/ingest`, payload);
  assert.equal(first.body.inserted, 1);

  const second = await postJson(`${baseUrl}/mobile/items/ingest`, {
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

test("POST /mobile/items/ingest — missing deviceId → HTTP 400", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/mobile/items/ingest`, {
    items: [{ id: "x", itemType: "moment", title: "t", summary: "s" }],
  });
  assert.equal(status, 400);
  assert.equal(body.ok, false);
}));

test("POST /mobile/items/ingest — empty items array → accepted=0, no rows", withTempHome(async (baseUrl) => {
  const { status, body } = await postJson(`${baseUrl}/mobile/items/ingest`, {
    deviceId: "empty-dev",
    items: [],
  });
  assert.equal(status, 200);
  assert.equal(body.accepted, 0);
  assert.equal(body.inserted, 0);
  const signals = await listPersonalSignals({ status: "open" });
  assert.equal(signals.length, 0);
}));

test("GET /mobile/items → HTTP 410 with migration hint", withTempHome(async (baseUrl) => {
  const res = await fetch(`${baseUrl}/mobile/items`);
  assert.equal(res.status, 410);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.hint ?? "", /pin signals/);
}));
