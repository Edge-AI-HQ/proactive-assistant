import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { handleSettings } from "./settings.ts";

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

test("handleSettings accepts zh alias and stores normalized generation language", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const handler = handleSettings({
    updateUserSettings: async (fields) => {
      updates.push(fields);
    },
  } as never);
  const res = createResponse();

  const handled = await handler({
    subpath: "/settings/generation-language",
    req: createRequest("POST", { language: "zh" }),
    res,
    url: new URL("http://localhost/settings/generation-language"),
    api: {} as never,
  } as never);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(updates, [{ generation_language: "zh-Hans" }]);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    language: "zh-Hans",
    defaultLanguage: "zh-Hans",
    options: [
      { value: "en", label: "English" },
      { value: "zh-Hans", label: "Simplified Chinese" },
      { value: "ja", label: "Japanese" },
      { value: "ko", label: "Korean" },
      { value: "es", label: "Spanish" },
      { value: "fr", label: "French" },
      { value: "de", label: "German" },
      { value: "pt", label: "Portuguese" },
    ],
  });
});

test("handleSettings rejects unsupported generation language on dedicated endpoint", async () => {
  let updated = false;
  const handler = handleSettings({
    updateUserSettings: async () => {
      updated = true;
    },
  } as never);
  const res = createResponse();

  const handled = await handler({
    subpath: "/settings/generation-language",
    req: createRequest("POST", { language: "it" }),
    res,
    url: new URL("http://localhost/settings/generation-language"),
    api: {} as never,
  } as never);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(updated, false);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "Unsupported language" });
});

test("handleSettings rejects unsupported generation language on generic settings endpoint", async () => {
  let updated = false;
  const handler = handleSettings({
    updateUserSettings: async () => {
      updated = true;
    },
  } as never);
  const res = createResponse();

  const handled = await handler({
    subpath: "/settings",
    req: createRequest("POST", { generation_language: "it" }),
    res,
    url: new URL("http://localhost/settings"),
    api: {} as never,
  } as never);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(updated, false);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "Unsupported generation_language" });
});

// ── /settings/auto-dreaming ─────────────────────────────────────────────
//
// The toggle in proactive-ai-frontend/src/components/AutoDreamingSettings.tsx
// hits this endpoint. If the GET shape changes the switch goes blank, and
// if POST stops persisting, the user thinks dreaming is on while the
// scheduler keeps skipping it.

function makeUserSettings(overrides: Partial<{ auto_dreaming: boolean; auto_crystallize: boolean }> = {}) {
  return {
    user_id: "local",
    generation_language: "en",
    auto_generate: true,
    auto_dreaming: false,
    auto_crystallize: true,
    metadata: {},
    updated_at: "2026-04-24T00:00:00.000Z",
    ...overrides,
  };
}

test("GET /settings/auto-dreaming returns the current enabled flag", async () => {
  const handler = handleSettings({
    getUserSettings: async () => makeUserSettings({ auto_dreaming: true }),
  } as never);
  const res = createResponse();
  const handled = await handler({
    subpath: "/settings/auto-dreaming",
    req: createRequest("GET"),
    res,
    url: new URL("http://localhost/settings/auto-dreaming"),
    api: {} as never,
  } as never);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.enabled, true);
  assert.equal(body.schedule, null);
});

test("POST /settings/auto-dreaming persists the flag and echoes it back", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const handler = handleSettings({
    updateUserSettings: async (fields) => { updates.push(fields); },
  } as never);
  const res = createResponse();
  const handled = await handler({
    subpath: "/settings/auto-dreaming",
    req: createRequest("POST", { enabled: true }),
    res,
    url: new URL("http://localhost/settings/auto-dreaming"),
    api: {} as never,
  } as never);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, enabled: true, schedule: null });
  assert.deepEqual(updates, [{ auto_dreaming: true }]);
});

test("POST /settings/auto-dreaming rejects non-boolean enabled with 400", async () => {
  let updated = false;
  const handler = handleSettings({
    updateUserSettings: async () => { updated = true; },
  } as never);
  const res = createResponse();
  await handler({
    subpath: "/settings/auto-dreaming",
    req: createRequest("POST", { enabled: "yes" }),
    res,
    url: new URL("http://localhost/settings/auto-dreaming"),
    api: {} as never,
  } as never);
  assert.equal(res.statusCode, 400);
  assert.equal(updated, false);
});

// ── /settings/auto-crystallize ──────────────────────────────────────────

test("GET /settings/auto-crystallize returns the current enabled flag", async () => {
  const handler = handleSettings({
    getUserSettings: async () => makeUserSettings({ auto_crystallize: false }),
  } as never);
  const res = createResponse();
  const handled = await handler({
    subpath: "/settings/auto-crystallize",
    req: createRequest("GET"),
    res,
    url: new URL("http://localhost/settings/auto-crystallize"),
    api: {} as never,
  } as never);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, enabled: false });
});

test("POST /settings/auto-crystallize persists the flag and echoes it back", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const handler = handleSettings({
    updateUserSettings: async (fields) => { updates.push(fields); },
  } as never);
  const res = createResponse();
  await handler({
    subpath: "/settings/auto-crystallize",
    req: createRequest("POST", { enabled: false }),
    res,
    url: new URL("http://localhost/settings/auto-crystallize"),
    api: {} as never,
  } as never);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, enabled: false });
  assert.deepEqual(updates, [{ auto_crystallize: false }]);
});

test("POST /settings/auto-crystallize rejects non-boolean enabled with 400", async () => {
  let updated = false;
  const handler = handleSettings({
    updateUserSettings: async () => { updated = true; },
  } as never);
  const res = createResponse();
  await handler({
    subpath: "/settings/auto-crystallize",
    req: createRequest("POST", {}),
    res,
    url: new URL("http://localhost/settings/auto-crystallize"),
    api: {} as never,
  } as never);
  assert.equal(res.statusCode, 400);
  assert.equal(updated, false);
});
