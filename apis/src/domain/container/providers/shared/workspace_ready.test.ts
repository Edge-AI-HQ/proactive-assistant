import test from "node:test";
import assert from "node:assert/strict";
import {
  PINAI_WORKSPACE_ERROR_MARKER,
  PINAI_WORKSPACE_READY_MARKER,
  PINAI_WORKSPACE_STATUS_PATH,
  PINAI_WORKSPACE_STATUS_PORT,
} from "./workspace_ready.js";

test("workspace ready constants stay stable for runtime probes", () => {
  assert.equal(PINAI_WORKSPACE_STATUS_PORT, 8790);
  assert.equal(PINAI_WORKSPACE_STATUS_PATH, "/pinai/workspace-ready");
  assert.match(PINAI_WORKSPACE_READY_MARKER, /workspace-ready$/);
  assert.match(PINAI_WORKSPACE_ERROR_MARKER, /workspace-error$/);
});
