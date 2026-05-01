/**
 * Unit tests for the device registry token logic that doesn't touch pg.
 * The full registerDevice() / findDeviceByToken() integration test
 * requires a running Postgres and lives in CI's e2e suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { pool, type Queryable } from "../common/db/core.js";

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

test("registerDevice: reuses the same user's device when fingerprint matches", async () => {
  const { registerDevice } = await import("./index.js");
  const mutablePool = pool as unknown as Queryable;
  const originalQuery = mutablePool.query;
  const queries: string[] = [];
  const existingRow = {
    id: 42,
    device_id: "existing-ios-logical-device",
    user_id: 7,
    platform: "ios",
    display_name: "Smile iPhone",
    app_version: "1.0.0",
    model: "iPhone",
    registered_at: new Date(0).toISOString(),
    last_seen_at: null,
    status: "active",
    metadata: {},
    device_fingerprint_hash: "hash",
  };

  mutablePool.query = async <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }> => {
    queries.push(sql);
    if (sql.includes("WHERE device_id = $1")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("WHERE user_id = $1") && sql.includes("device_fingerprint_hash")) {
      return { rows: [existingRow as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE user_devices")) {
      return {
        rows: [{
          ...existingRow,
          display_name: params?.[2] ?? existingRow.display_name,
          app_version: params?.[3] ?? existingRow.app_version,
          model: params?.[4] ?? existingRow.model,
          metadata: params?.[5] ? JSON.parse(String(params[5])) : existingRow.metadata,
        } as T],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO user_devices")) {
      return {
        rows: [{
          ...existingRow,
          id: 99,
          device_id: "new-duplicate-device",
        } as T],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  try {
    const input = {
      userId: 7,
      deviceId: "fresh-install-id",
      platform: "ios" as const,
      displayName: "Smile iPhone",
      appVersion: "1.0.0",
      model: "iPhone",
      deviceFingerprint: "keychain-stable-uuid",
      metadata: { credential_store: "secure-storage" },
    };
    const device = await registerDevice(input);
    assert.equal(device.device_id, "existing-ios-logical-device");
    assert.equal(queries.some((sql) => sql.includes("INSERT INTO user_devices")), false);
  } finally {
    mutablePool.query = originalQuery;
  }
});
