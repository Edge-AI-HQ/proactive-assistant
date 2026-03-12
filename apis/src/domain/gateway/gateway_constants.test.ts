import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_ROLE,
  GATEWAY_CLIENT_SCOPES,
} from "./gateway_constants.js";

test("gateway constants: client ID is gateway-client (not control-ui)", () => {
  assert.equal(GATEWAY_CLIENT_ID, "gateway-client");
  // Must NOT be "openclaw-control-ui" to avoid stricter auth checks
  assert.notEqual(GATEWAY_CLIENT_ID, "openclaw-control-ui");
});

test("gateway constants: role is operator with admin scope", () => {
  assert.equal(GATEWAY_CLIENT_ROLE, "operator");
  assert.deepEqual(GATEWAY_CLIENT_SCOPES, ["operator.admin"]);
});
