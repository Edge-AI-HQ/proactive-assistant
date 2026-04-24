/**
 * v3-direct mobile ingest: /mobile/items/ingest writes straight into
 * personal_signals, and snapshot-type items additionally fan out to
 * raw.db. Legacy list / claim / commit endpoints are 410 Gone.
 *
 * See docs/plans/memory-architecture.mdx §四.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleMobile } from "./mobile.ts";
import { listPersonalSignals, resetDbForTests } from "../db.ts";
import { listDeviceApps, listDeviceContacts, resetRawDbForTests } from "../raw-db.ts";

function withTempHome(fn: (home: string) => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-routes-"));
    process.env.OPENCLAW_HOME = home;
    resetDbForTests();
    resetRawDbForTests();
    try {
      await fn(home);
    } finally {
      resetDbForTests();
      resetRawDbForTests();
      if (previous === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previous;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function createRequest(method: string, body?: Record<string, unknown>) {
  const req = new PassThrough() as PassThrough & { method: string };
  req.method = method;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      response.statusCode = status;
      response.headers = headers;
      return response;
    },
    end(chunk?: string) {
      if (chunk) response.body += chunk;
      return response;
    },
  };
  return response;
}

async function invoke(subpath: string, method: string, body?: Record<string, unknown>) {
  const handler = handleMobile();
  const res = createResponse();
  const handled = await handler({
    subpath,
    req: createRequest(method, body),
    res,
    url: new URL(`http://localhost${subpath}`),
    api: {} as never,
  } as never);
  return { handled, res };
}

test("handleMobile /mobile/items/ingest writes all items to personal_signals", withTempHome(async () => {
  const { handled, res } = await invoke("/mobile/items/ingest", "POST", {
    deviceId: "pixel-1",
    items: [
      {
        id: "item-1", itemType: "session_summary",
        title: "Session summary", summary: "Discussed travel packing.",
        payload: { sessionId: "session-1" },
        salience: 0.9, confidence: 0.8,
        dedupeKey: "session:session-1",
        occurredAt: "2026-04-16T08:00:00.000Z",
      },
      {
        id: "item-2", itemType: "attention_item",
        title: "Reply to an order", summary: "A delivery update.",
        payload: { packageName: "com.shop" },
        salience: 0.7, confidence: 0.6,
        dedupeKey: "notification:com.shop:1",
        occurredAt: "2026-04-16T08:05:00.000Z",
      },
    ],
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, 2);
  assert.equal(body.inserted, 2);

  const signals = await listPersonalSignals({ status: "open" });
  assert.equal(signals.length, 2);
  const kinds = signals.map((s) => s.kind).sort();
  assert.deepEqual(kinds, ["attention_item", "session_summary"]);
  const sessionSignal = signals.find((s) => s.kind === "session_summary")!;
  assert.equal(sessionSignal.device_id, "pixel-1");
  assert.equal(sessionSignal.source, "device");
}));

test("handleMobile /mobile/items/ingest fans snapshot items to raw.db", withTempHome(async () => {
  const { handled, res } = await invoke("/mobile/items/ingest", "POST", {
    deviceId: "iphone-1",
    items: [
      {
        id: "apps-1", itemType: "app_inventory_bootstrap",
        title: "Apps", summary: "3 apps",
        payload: {
          apps: [
            { bundleId: "com.a", appName: "A" },
            { bundleId: "com.b", appName: "B" },
            { bundleId: "com.c", appName: "C" },
          ],
        },
        occurredAt: "2026-04-23T08:00:00.000Z",
      },
      {
        id: "contacts-1", itemType: "contact_directory_snapshot",
        title: "Contacts", summary: "2 contacts",
        payload: {
          contacts: [
            { displayName: "张三", phones: ["+8613800000000"] },
            { displayName: "Alice", emails: ["alice@x.com"] },
          ],
        },
        occurredAt: "2026-04-23T08:00:00.000Z",
      },
    ],
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);

  // Both items land in personal_signals (2 open rows)
  const signals = await listPersonalSignals({ status: "open" });
  assert.equal(signals.length, 2);

  // Snapshot payloads also fan out to raw.db
  const apps = listDeviceApps({ deviceId: "iphone-1", latestSnapshotOnly: true });
  assert.equal(apps.length, 3);

  const contacts = listDeviceContacts({ deviceId: "iphone-1", latestSnapshotOnly: true });
  assert.equal(contacts.length, 2);
  const zhang = contacts.find((c) => c.display_name === "张三");
  assert.ok(zhang);
  assert.deepEqual(zhang!.phones, ["+8613800000000"]);
}));

test("handleMobile /mobile/items/ingest: missing deviceId → 400", withTempHome(async () => {
  const { handled, res } = await invoke("/mobile/items/ingest", "POST", {
    items: [{ id: "x", itemType: "moment", title: "t", summary: "s" }],
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
}));

test("handleMobile /mobile/items/ingest: bad items filtered, good ones stored", withTempHome(async () => {
  const { handled, res } = await invoke("/mobile/items/ingest", "POST", {
    deviceId: "pixel-1",
    items: [
      { id: "", itemType: "moment", title: "t", summary: "s" },            // empty id → filtered
      { id: "ok", itemType: "moment", title: "t", summary: "s" },
    ],
  });
  assert.equal(handled, true);
  const body = JSON.parse(res.body);
  assert.equal(body.accepted, 1);
  assert.equal(body.inserted, 1);
}));

test("handleMobile /mobile/items/ingest: duplicate dedupeKey → ignored on second post", withTempHome(async () => {
  const first = await invoke("/mobile/items/ingest", "POST", {
    deviceId: "pixel-1",
    items: [{ id: "d1", itemType: "moment", title: "t", summary: "s", dedupeKey: "k1" }],
  });
  assert.equal(JSON.parse(first.res.body).inserted, 1);
  const second = await invoke("/mobile/items/ingest", "POST", {
    deviceId: "pixel-1",
    items: [{ id: "d2", itemType: "moment", title: "t2", summary: "s2", dedupeKey: "k1" }],
  });
  const body = JSON.parse(second.res.body);
  assert.equal(body.accepted, 1);
  assert.equal(body.inserted, 0);
  assert.equal(body.ignored, 1);
}));

test("handleMobile /mobile/items GET now returns 410 Gone", withTempHome(async () => {
  const { handled, res } = await invoke("/mobile/items", "GET");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 410);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.hint ?? "", /pin signals/);
}));

test("handleMobile /mobile/items/claim now returns 410 Gone", withTempHome(async () => {
  const { handled, res } = await invoke("/mobile/items/claim", "POST", {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 410);
}));

test("handleMobile /mobile/items/commit now returns 410 Gone", withTempHome(async () => {
  const { handled, res } = await invoke("/mobile/items/commit", "POST", { runToken: "x" });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 410);
}));

test("handleMobile does not claim unrelated paths", withTempHome(async () => {
  const { handled } = await invoke("/something/else", "GET");
  assert.equal(handled, false);
}));
