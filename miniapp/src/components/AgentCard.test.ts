import test from "node:test";
import assert from "node:assert/strict";
import { decideDataConnectorsAction } from "./agentCardActions";

test("blocks data connectors when runtime is not running", () => {
  assert.equal(decideDataConnectorsAction(false), "blocked");
});

test("opens data connectors when runtime is running", () => {
  assert.equal(decideDataConnectorsAction(true), "open");
});
