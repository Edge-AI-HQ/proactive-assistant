import test from "node:test";
import assert from "node:assert/strict";

import { buildMobileProxyHeaders, isMobileProxyEnabled, rewriteMobileProxyPath } from "./mobile_proxy.js";

test("rewriteMobileProxyPath rewrites /api/proactive/devices/* to /devices/*", () => {
  assert.equal(
    rewriteMobileProxyPath("/api/proactive/devices/ingest?foo=1"),
    "/proactive-ai/api/devices/ingest?foo=1",
  );
  assert.equal(
    rewriteMobileProxyPath("/api/proactive/devices/something?x=1"),
    "/proactive-ai/api/devices/something?x=1",
  );
});

test("rewriteMobileProxyPath leaves unrelated paths unchanged", () => {
  // Defensive: only the /api/proactive/devices/ prefix is supposed to
  // hit this function (the route mount point), but if anything else
  // sneaks in we shouldn't silently rewrite it to /devices/*.
  assert.equal(
    rewriteMobileProxyPath("/api/mobile/items/ingest"),
    "/api/mobile/items/ingest",
  );
  assert.equal(
    rewriteMobileProxyPath("/some/other/path"),
    "/some/other/path",
  );
});

test("buildMobileProxyHeaders overwrites auth and host for the target container", () => {
  const headers = buildMobileProxyHeaders(
    {
      authorization: "Bearer user-token",
      origin: "https://example.test",
      "content-type": "application/json",
      connection: "keep-alive",
    },
    {
      gatewayToken: "gateway-token",
      targetBaseUrl: "http://127.0.0.1:8080",
      hostOverride: "assistant.internal:8080",
    },
  );

  assert.equal(headers.Authorization, "Bearer gateway-token");
  assert.equal(headers.host, "assistant.internal:8080");
  assert.equal(headers.origin, "https://example.test");
  assert.equal(headers["content-type"], "application/json");
  assert.equal("authorization" in headers, false);
  assert.equal("connection" in headers, false);
});

test("isMobileProxyEnabled defaults on in production and keeps env as a kill switch", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOverride = process.env.MOBILE_SYNC_PROXY_ENABLED;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.MOBILE_SYNC_PROXY_ENABLED;
    assert.equal(isMobileProxyEnabled(), true);

    for (const value of ["0", "false", "off", "no"]) {
      process.env.MOBILE_SYNC_PROXY_ENABLED = value;
      assert.equal(isMobileProxyEnabled(), false);
    }

    process.env.MOBILE_SYNC_PROXY_ENABLED = "1";
    assert.equal(isMobileProxyEnabled(), true);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousOverride === undefined) {
      delete process.env.MOBILE_SYNC_PROXY_ENABLED;
    } else {
      process.env.MOBILE_SYNC_PROXY_ENABLED = previousOverride;
    }
  }
});
