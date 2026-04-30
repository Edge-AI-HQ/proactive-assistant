import test from "node:test";
import assert from "node:assert/strict";

import { buildMobileProxyHeaders, isMobileProxyEnabled, refreshMobileProxyContainer, rewriteMobileProxyPath } from "./mobile_proxy.js";

test("rewriteMobileProxyPath rewrites legacy /api/mobile/items/ingest to /devices/ingest", () => {
  assert.equal(
    rewriteMobileProxyPath("/api/mobile/items/ingest?foo=1"),
    "/proactive-ai/api/devices/ingest?foo=1",
  );
});

test("rewriteMobileProxyPath rewrites preferred /api/proactive/devices/* to /devices/*", () => {
  assert.equal(
    rewriteMobileProxyPath("/api/proactive/devices/ingest?foo=1"),
    "/proactive-ai/api/devices/ingest?foo=1",
  );
  assert.equal(
    rewriteMobileProxyPath("/api/proactive/devices/something?x=1"),
    "/proactive-ai/api/devices/something?x=1",
  );
});

test("rewriteMobileProxyPath also rewrites bare /api/mobile/* fallback paths", () => {
  assert.equal(
    rewriteMobileProxyPath("/api/mobile/items?status=pending&limit=10"),
    "/proactive-ai/api/devices/items?status=pending&limit=10",
  );
  assert.equal(
    rewriteMobileProxyPath("/api/mobile"),
    "/proactive-ai/api/devices/",
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

test("refreshMobileProxyContainer prefers reconciled container data when available", async () => {
  const container = {
    id: 1,
    owner_user_id: 1,
    scope: "user" as const,
    runtime_provider: "docker" as const,
    container_name: "proactive-285d35b0",
    runtime_ref: "old-ref",
    host_port: 55004,
    status: "running" as const,
    metadata: { hostPort: "55004" },
    created_at: "2026-04-18T00:00:00.000Z",
    updated_at: "2026-04-18T00:00:00.000Z",
    last_active_at: null,
    container_proxy_secret: "gateway-token",
    user_key: "285d35b0-e031-4cfd-97b3-0e21064d0d0e",
  };
  const refreshed = await refreshMobileProxyContainer(
    {
      reconcileContainer: async () => ({
        ...container,
        runtime_ref: "new-ref",
        host_port: 55005,
        metadata: { hostPort: "55005" },
      }),
    } as any,
    container,
  );

  assert.equal(refreshed?.runtime_ref, "new-ref");
  assert.equal(refreshed?.host_port, 55005);
  assert.deepEqual(refreshed?.metadata, { hostPort: "55005" });
  assert.equal(refreshed?.user_key, container.user_key);
});
