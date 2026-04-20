import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleMobile } from "./mobile.ts";
import { expireOldMobileItemRuns, resetMobileDbForTests } from "../mobile-db.ts";

function withTempHome(fn: (home: string) => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-routes-"));
    process.env.OPENCLAW_HOME = home;
    resetMobileDbForTests();
    try {
      await fn(home);
    } finally {
      resetMobileDbForTests();
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

test("handleMobile ingests, lists, claims, and commits mobile items", withTempHome(async () => {
  const handler = handleMobile();

  const ingestRes = createResponse();
  const ingestHandled = await handler({
    subpath: "/mobile/items/ingest",
    req: createRequest("POST", {
      deviceId: "pixel-1",
      items: [
        {
          id: "item-1",
          itemType: "session_summary",
          title: "Session summary",
          summary: "Discussed travel packing and timing.",
          payload: { sessionId: "session-1" },
          salience: 0.9,
          confidence: 0.8,
          dedupeKey: "session:session-1",
          occurredAt: "2026-04-16T08:00:00.000Z",
          availableAt: "2026-04-16T08:00:00.000Z",
          expiresAt: "2099-04-17T08:00:00.000Z",
        },
        {
          id: "item-2",
          itemType: "attention_item",
          title: "Reply to an order message",
          summary: "A delivery update likely needs action.",
          payload: { packageName: "com.shop" },
          salience: 0.7,
          confidence: 0.6,
          dedupeKey: "notification:com.shop:1",
          occurredAt: "2026-04-16T08:05:00.000Z",
          availableAt: "2026-04-16T08:05:00.000Z",
          expiresAt: "2099-04-17T08:05:00.000Z",
        },
      ],
    }),
    res: ingestRes,
    url: new URL("http://localhost/mobile/items/ingest"),
    api: {} as never,
  } as never);

  assert.equal(ingestHandled, true);
  assert.equal(ingestRes.statusCode, 200);
  assert.deepEqual(JSON.parse(ingestRes.body), {
    ok: true,
    accepted: 2,
    inserted: 2,
    ignored: 0,
  });

  const listRes = createResponse();
  const listHandled = await handler({
    subpath: "/mobile/items",
    req: createRequest("GET"),
    res: listRes,
    url: new URL("http://localhost/mobile/items?status=pending&limit=10"),
    api: {} as never,
  } as never);

  assert.equal(listHandled, true);
  assert.equal(listRes.statusCode, 200);
  const listed = JSON.parse(listRes.body);
  assert.equal(listed.ok, true);
  assert.equal(listed.items.length, 2);
  assert.equal(listed.items[0].id, "item-1");
  assert.equal(listed.items[1].id, "item-2");

  const claimRes = createResponse();
  const claimHandled = await handler({
    subpath: "/mobile/items/claim",
    req: createRequest("POST", { limit: 1 }),
    res: claimRes,
    url: new URL("http://localhost/mobile/items/claim"),
    api: {} as never,
  } as never);

  assert.equal(claimHandled, true);
  assert.equal(claimRes.statusCode, 200);
  const claimed = JSON.parse(claimRes.body);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.items.length, 1);
  assert.equal(claimed.items[0].id, "item-1");
  assert.equal(typeof claimed.runToken, "string");

  const commitRes = createResponse();
  const commitHandled = await handler({
    subpath: "/mobile/items/commit",
    req: createRequest("POST", { runToken: claimed.runToken }),
    res: commitRes,
    url: new URL("http://localhost/mobile/items/commit"),
    api: {} as never,
  } as never);

  assert.equal(commitHandled, true);
  assert.equal(commitRes.statusCode, 200);
  assert.deepEqual(JSON.parse(commitRes.body), {
    ok: true,
    runToken: claimed.runToken,
    processed: 1,
  });
}));

test("handleMobile ignores duplicate dedupe keys on ingest", withTempHome(async () => {
  const handler = handleMobile();
  const body = {
    deviceId: "pixel-1",
    items: [
      {
        id: "item-a",
        itemType: "moment",
        title: "At office",
        summary: "Arrived at the office",
        payload: { place: "office" },
        salience: 0.5,
        confidence: 0.9,
        dedupeKey: "moment:office:morning",
        occurredAt: "2026-04-16T09:00:00.000Z",
        availableAt: "2026-04-16T09:00:00.000Z",
        expiresAt: "2026-04-17T09:00:00.000Z",
      },
      {
        id: "item-b",
        itemType: "moment",
        title: "At office",
        summary: "Arrived at the office again",
        payload: { place: "office" },
        salience: 0.5,
        confidence: 0.9,
        dedupeKey: "moment:office:morning",
        occurredAt: "2026-04-16T09:01:00.000Z",
        availableAt: "2026-04-16T09:01:00.000Z",
        expiresAt: "2026-04-17T09:01:00.000Z",
      },
    ],
  };

  const firstRes = createResponse();
  await handler({
    subpath: "/mobile/items/ingest",
    req: createRequest("POST", body),
    res: firstRes,
    url: new URL("http://localhost/mobile/items/ingest"),
    api: {} as never,
  } as never);

  assert.deepEqual(JSON.parse(firstRes.body), {
    ok: true,
    accepted: 2,
    inserted: 1,
    ignored: 1,
  });
}));

test("handleMobile accepts millisecond timestamps from mobile clients", withTempHome(async () => {
  const handler = handleMobile();
  const occurredAt = Date.parse("2027-04-16T10:00:00.000Z");

  const ingestRes = createResponse();
  await handler({
    subpath: "/mobile/items/ingest",
    req: createRequest("POST", {
      deviceId: "pixel-3",
      items: [
        {
          id: "item-ms",
          itemType: "moment",
          title: "Arrived",
          summary: "Arrived at office",
          payload: { place: "office" },
          salience: 0.5,
          confidence: 0.8,
          dedupeKey: "moment:office",
          occurredAt,
          availableAt: occurredAt,
          expiresAt: occurredAt + 60_000,
        },
      ],
    }),
    res: ingestRes,
    url: new URL("http://localhost/mobile/items/ingest"),
    api: {} as never,
  } as never);

  const listRes = createResponse();
  await handler({
    subpath: "/mobile/items",
    req: createRequest("GET"),
    res: listRes,
    url: new URL("http://localhost/mobile/items?status=pending&limit=10"),
    api: {} as never,
  } as never);

  const listed = JSON.parse(listRes.body);
  assert.equal(listed.items[0].occurredAt, "2027-04-16T10:00:00.000Z");
  assert.equal(listed.items[0].availableAt, "2027-04-16T10:00:00.000Z");
  assert.equal(listed.items[0].expiresAt, "2027-04-16T10:01:00.000Z");
}));

test("handleMobile lists latest-first items when order desc is requested", withTempHome(async () => {
  const handler = handleMobile();

  await handler({
    subpath: "/mobile/items/ingest",
    req: createRequest("POST", {
      deviceId: "pixel-5",
      items: [
        {
          id: "contact-old",
          itemType: "contact_directory_snapshot",
          title: "Contacts snapshot",
          summary: "Older snapshot",
          payload: { contacts: [{ contactId: "old-1", displayName: "Old Contact" }] },
          salience: 0.5,
          confidence: 0.8,
          dedupeKey: "contact:old",
          occurredAt: "2026-04-16T10:00:00.000Z",
          availableAt: "2026-04-16T10:00:00.000Z",
          expiresAt: "2026-04-20T10:00:00.000Z",
        },
        {
          id: "contact-new",
          itemType: "contact_directory_snapshot",
          title: "Contacts snapshot",
          summary: "Newer snapshot",
          payload: { contacts: [{ contactId: "new-1", displayName: "New Contact" }] },
          salience: 0.5,
          confidence: 0.8,
          dedupeKey: "contact:new",
          occurredAt: "2026-04-17T10:00:00.000Z",
          availableAt: "2026-04-17T10:00:00.000Z",
          expiresAt: "2026-04-21T10:00:00.000Z",
        },
      ],
    }),
    res: createResponse(),
    url: new URL("http://localhost/mobile/items/ingest"),
    api: {} as never,
  } as never);

  const listRes = createResponse();
  await handler({
    subpath: "/mobile/items",
    req: createRequest("GET"),
    res: listRes,
    url: new URL("http://localhost/mobile/items?type=contact_directory_snapshot&order=desc&limit=1"),
    api: {} as never,
  } as never);

  const listed = JSON.parse(listRes.body);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, "contact-new");
  assert.deepEqual(listed.items[0].payload.contacts, [{ contactId: "new-1", displayName: "New Contact" }]);
}));

test("expired claim runs release items back to pending", withTempHome(async () => {
  const handler = handleMobile();
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const ingestRes = createResponse();
  await handler({
    subpath: "/mobile/items/ingest",
    req: createRequest("POST", {
      deviceId: "pixel-4",
      items: [
        {
          id: "item-reclaim",
          itemType: "attention_item",
          title: "Follow up",
          summary: "Needs response",
          payload: { source: "notification" },
          salience: 0.6,
          confidence: 0.7,
          dedupeKey: "attention:reclaim",
          occurredAt,
          availableAt: occurredAt,
          expiresAt,
        },
      ],
    }),
    res: ingestRes,
    url: new URL("http://localhost/mobile/items/ingest"),
    api: {} as never,
  } as never);

  const firstClaimRes = createResponse();
  await handler({
    subpath: "/mobile/items/claim",
    req: createRequest("POST", { limit: 1 }),
    res: firstClaimRes,
    url: new URL("http://localhost/mobile/items/claim"),
    api: {} as never,
  } as never);
  const firstClaim = JSON.parse(firstClaimRes.body);
  assert.equal(firstClaim.items.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  expireOldMobileItemRuns(0);

  const secondClaimRes = createResponse();
  await handler({
    subpath: "/mobile/items/claim",
    req: createRequest("POST", { limit: 1 }),
    res: secondClaimRes,
    url: new URL("http://localhost/mobile/items/claim"),
    api: {} as never,
  } as never);
  const secondClaim = JSON.parse(secondClaimRes.body);
  assert.equal(secondClaim.items.length, 1);
  assert.equal(secondClaim.items[0].id, "item-reclaim");
}));
