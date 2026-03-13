import test from "node:test";
import assert from "node:assert/strict";
import { shouldDisconnectAfterConfirm } from "./DataConnectionsDialog";

test("returns false when connector is busy", () => {
  const result = shouldDisconnectAfterConfirm({
    connected: true,
    busy: true,
    confirmDisconnect: () => true,
  });

  assert.equal(result, false);
});

test("returns false when not connected", () => {
  const result = shouldDisconnectAfterConfirm({
    connected: false,
    busy: false,
    confirmDisconnect: () => true,
  });

  assert.equal(result, false);
});

test("returns false when user cancels confirm", () => {
  const result = shouldDisconnectAfterConfirm({
    connected: true,
    busy: false,
    confirmDisconnect: () => false,
  });

  assert.equal(result, false);
});

test("returns true when connected and user confirms", () => {
  const result = shouldDisconnectAfterConfirm({
    connected: true,
    busy: false,
    confirmDisconnect: () => true,
  });

  assert.equal(result, true);
});
