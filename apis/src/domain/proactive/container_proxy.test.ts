import test from "node:test";
import assert from "node:assert/strict";

import {
  getProactiveProxyTimeoutMs,
  rewriteProactiveProxyPath,
} from "./container_proxy.js";

test("rewriteProactiveProxyPath rewrites /api/proxy/* to proactive plugin API", () => {
  assert.equal(
    rewriteProactiveProxyPath("/api/proxy/health"),
    "/proactive-ai/api/health",
  );
  assert.equal(
    rewriteProactiveProxyPath("/api/proxy/generate?limit=1"),
    "/proactive-ai/api/generate?limit=1",
  );
});

test("getProactiveProxyTimeoutMs keeps health probes short without affecting long-running APIs", () => {
  assert.equal(
    getProactiveProxyTimeoutMs("GET", "/proactive-ai/api/health"),
    4_000,
  );
  assert.equal(
    getProactiveProxyTimeoutMs("POST", "/proactive-ai/api/generate"),
    600_000,
  );
});
