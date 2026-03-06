import assert from "node:assert/strict";
import test from "node:test";
import { summarizeContainerProvisionResults } from "./containerProvisionMessage.js";

test("summarizeContainerProvisionResults groups by state", () => {
  const summary = summarizeContainerProvisionResults([
    { label: "@a", state: "ready" },
    { label: "@b", state: "starting" },
    { label: "@c", state: "failed" },
    { label: "@d", state: "ready" },
  ]);

  assert.deepEqual(summary.ready, ["@a", "@d"]);
  assert.deepEqual(summary.starting, ["@b"]);
  assert.deepEqual(summary.failed, ["@c"]);
});

