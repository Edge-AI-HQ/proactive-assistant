import test from "node:test";
import assert from "node:assert/strict";

import { buildMobileProxyHeaders, isMobileProxyEnabled, rewriteMobileProxyPath } from "./mobile_proxy.js";

test("rewriteMobileProxyPath rewrites /api/mobile prefix to plugin mobile route", () => {
  assert.equal(
    rewriteMobileProxyPath("/api/mobile/items/ingest?foo=1"),
    "/proactive-ai/api/mobile/items/ingest?foo=1",
  );
  assert.equal(
    rewriteMobileProxyPath("/api/mobile/items?status=pending&limit=10"),
    "/proactive-ai/api/mobile/items?status=pending&limit=10",
  );
  assert.equal(
    rewriteMobileProxyPath("/api/mobile"),
    "/proactive-ai/api/mobile/",
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

test("isMobileProxyEnabled is disabled in production unless explicitly overridden", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOverride = process.env.MOBILE_SYNC_PROXY_ENABLED;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.MOBILE_SYNC_PROXY_ENABLED;
    assert.equal(isMobileProxyEnabled(), false);

    process.env.MOBILE_SYNC_PROXY_ENABLED = "1";
    assert.equal(isMobileProxyEnabled(), true);

    process.env.NODE_ENV = "development";
    delete process.env.MOBILE_SYNC_PROXY_ENABLED;
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
