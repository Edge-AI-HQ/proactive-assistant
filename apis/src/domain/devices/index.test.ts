/**
 * Unit tests for the device registry token logic that doesn't touch pg.
 * The full registerDevice() / findDeviceByToken() integration test
 * requires a running Postgres and lives in CI's e2e suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

// We re-export the token byte length + bcrypt rounds via internal helpers
// to keep the test in lock-step. For now we just exercise bcrypt round-trip
// behaviour which our findDeviceByToken relies on.

test("bcrypt round-trip: a generated token validates against its hash", async () => {
  const token = "test-plain-token-12345";
  const hash = await bcrypt.hash(token, 10);
  const ok = await bcrypt.compare(token, hash);
  assert.equal(ok, true);
});

test("bcrypt round-trip: wrong token does not validate", async () => {
  const hash = await bcrypt.hash("real-token", 10);
  const ok = await bcrypt.compare("wrong-token", hash);
  assert.equal(ok, false);
});

test("registerDevice: validates deviceId length (no DB needed)", async () => {
  const { registerDevice } = await import("./index.js");
  await assert.rejects(
    registerDevice({ userId: 1, deviceId: "short", platform: "ios" }),
    /at least 8 characters/,
  );
});

test("registerDevice: validates platform enum (no DB needed)", async () => {
  const { registerDevice } = await import("./index.js");
  await assert.rejects(
    registerDevice({ userId: 1, deviceId: "valid-device-id", platform: "windows-phone" as any }),
    /unsupported platform/,
  );
});
