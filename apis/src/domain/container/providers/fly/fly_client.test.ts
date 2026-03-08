import test from "node:test";
import assert from "node:assert/strict";

import { extractMachineIdFromNameConflictError } from "./fly_client.js";

test("extractMachineIdFromNameConflictError parses machine id from fly 409 error", () => {
  const error = new Error(
    'Fly API POST /apps/pinclaw-assistant-dev/machines failed (409): {"error":"already_exists: unique machine name violation, machine ID e7846453a14508 already exists with name \\"assistant-6142814327\\""}',
  );

  assert.equal(extractMachineIdFromNameConflictError(error), "e7846453a14508");
});

test("extractMachineIdFromNameConflictError returns null when id is missing", () => {
  const error = new Error("Fly API failed (409): already_exists: unique machine name violation");
  assert.equal(extractMachineIdFromNameConflictError(error), null);
});
