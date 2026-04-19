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
