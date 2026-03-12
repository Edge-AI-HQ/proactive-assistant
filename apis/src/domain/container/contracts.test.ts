import assert from "node:assert/strict";
import test from "node:test";
import { gatewayHostHeaders, type GatewayTarget } from "./contracts.js";

// ---------------------------------------------------------------------------
// gatewayHostHeaders
// ---------------------------------------------------------------------------

test("gatewayHostHeaders: without hostOverride returns Origin from httpBaseUrl", () => {
  const target: GatewayTarget = {
    host: "fdaa:0:abc::2",
    port: 18789,
    httpBaseUrl: "http://[fdaa:0:abc::2]:18789",
    wsBaseUrl: "ws://[fdaa:0:abc::2]:18789",
  };
  const headers = gatewayHostHeaders(target);
  assert.equal(headers.Origin, "http://[fdaa:0:abc::2]:18789");
  assert.equal(headers.Host, undefined);
});

test("gatewayHostHeaders: with hostOverride returns Host and Origin from override", () => {
  const target: GatewayTarget = {
    host: "fdaa:0:abc::2",
    port: 18789,
    httpBaseUrl: "http://[fdaa:0:abc::2]:18789",
    wsBaseUrl: "ws://[fdaa:0:abc::2]:18789",
    hostOverride: "127.0.0.1:18789",
  };
  const headers = gatewayHostHeaders(target);
  assert.equal(headers.Host, "127.0.0.1:18789");
  assert.equal(headers.Origin, "http://127.0.0.1:18789");
});

test("gatewayHostHeaders: localhost target without override", () => {
  const target: GatewayTarget = {
    host: "127.0.0.1",
    port: 18789,
    httpBaseUrl: "http://127.0.0.1:18789",
    wsBaseUrl: "ws://127.0.0.1:18789",
  };
  const headers = gatewayHostHeaders(target);
  assert.equal(headers.Origin, "http://127.0.0.1:18789");
  assert.equal(headers.Host, undefined);
});
