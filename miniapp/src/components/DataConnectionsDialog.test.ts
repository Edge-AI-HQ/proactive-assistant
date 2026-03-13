import test from "node:test";
import assert from "node:assert/strict";
import { decideGoogleConnectorAction } from "./DataConnectionsDialog";

test("returns none when connector is busy", () => {
  const result = decideGoogleConnectorAction({
    connected: true,
    busy: true,
  });

  assert.equal(result, "none");
});

test("returns connect when connector is not connected", () => {
  const result = decideGoogleConnectorAction({
    connected: false,
    busy: false,
  });

  assert.equal(result, "connect");
});

test("returns confirm-disconnect when connector is connected", () => {
  const result = decideGoogleConnectorAction({
    connected: true,
    busy: false,
  });

  assert.equal(result, "confirm-disconnect");
});
