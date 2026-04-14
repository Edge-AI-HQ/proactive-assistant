import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_ROLE,
  GATEWAY_CLIENT_SCOPES,
} from "./gateway_constants.js";

test("gateway constants: client ID is openclaw-control-ui for scope preservation", () => {
  // OpenClaw ≥2026.4 clears self-declared scopes for non-Control-UI clients (CVE-2026-32919)
  assert.equal(GATEWAY_CLIENT_ID, "openclaw-control-ui");
});

test("gateway constants: role is operator with admin scope", () => {
  assert.equal(GATEWAY_CLIENT_ROLE, "operator");
  assert.deepEqual(GATEWAY_CLIENT_SCOPES, ["operator.admin"]);
});
