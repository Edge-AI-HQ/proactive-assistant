/**
 * Tests for the device registration helper.
 * Mocks fetch + localStorage to isolate the SDK contract from the network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  clearDeviceCredentials,
  ensureDevice,
  withDeviceHeaders,
} from "./devices";

const { platformState, secureStore } = vi.hoisted(() => ({
  platformState: { isNative: false, platform: "web" },
  secureStore: new Map<string, string>(),
}));

// We mock the entire api module so proactiveFetch is replaceable.
vi.mock("./api", () => ({
  proactiveFetch: vi.fn(),
}));
vi.mock("./platform", () => ({
  API_BASE: "",
  get isNative() {
    return platformState.isNative;
  },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platformState.platform },
}));
vi.mock("@aparajita/capacitor-secure-storage", () => ({
  KeychainAccess: { afterFirstUnlockThisDeviceOnly: 3 },
  SecureStorage: {
    getItem: vi.fn(async (key: string) => secureStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { secureStore.set(key, value); }),
    setItem: vi.fn(async (key: string, value: string) => { secureStore.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { secureStore.delete(key); }),
  },
}));

import { proactiveFetch } from "./api";
const mockedFetch = proactiveFetch as unknown as ReturnType<typeof vi.fn>;

describe("ensureDevice", () => {
  beforeEach(() => {
    platformState.isNative = false;
    platformState.platform = "web";
    secureStore.clear();
    localStorage.clear();
    mockedFetch.mockReset();
  });

  afterEach(async () => {
    await clearDeviceCredentials();
  });

  test("registers a new device on first call and persists the token", async () => {
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        device: { device_id: "any-id-server-canonical", platform: "web" },
        device_token: "secret-token-once",
      }),
    });

    const creds = await ensureDevice();
    expect(creds.deviceToken).toBe("secret-token-once");
    expect(creds.deviceId).toBe("any-id-server-canonical");
    expect(localStorage.getItem("pin.deviceId")).toBe("any-id-server-canonical");
    expect(localStorage.getItem("pin.deviceToken")).toBe("secret-token-once");

    // Server received POST with deviceId + platform
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const call = mockedFetch.mock.calls[0]!;
    expect(call[0]).toBe("/api/proactive/devices/register");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.platform).toBe("web");
    expect(typeof body.deviceId).toBe("string");
    expect(body.deviceId.length).toBeGreaterThan(8);
  });

  test("returns cached credentials without hitting the network on subsequent calls", async () => {
    localStorage.setItem("pin.deviceId", "cached-id");
    localStorage.setItem("pin.deviceToken", "cached-token");
    const creds = await ensureDevice();
    expect(creds.deviceId).toBe("cached-id");
    expect(creds.deviceToken).toBe("cached-token");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test("native clients migrate cached localStorage credentials into secure storage", async () => {
    platformState.isNative = true;
    platformState.platform = "ios";
    localStorage.setItem("pin.deviceId", "cached-ios-id");
    localStorage.setItem("pin.deviceToken", "cached-ios-token");

    const creds = await ensureDevice();

    expect(creds.deviceId).toBe("cached-ios-id");
    expect(creds.deviceToken).toBe("cached-ios-token");
    expect(secureStore.get("pin.deviceId")).toBe("cached-ios-id");
    expect(secureStore.get("pin.deviceToken")).toBe("cached-ios-token");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test("native registration sends a stable fingerprint for server-side dedupe", async () => {
    platformState.isNative = true;
    platformState.platform = "ios";
    mockedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        device: { device_id: "server-logical-device-id", platform: "ios" },
        device_token: "secret-token-once",
      }),
    });

    const creds = await ensureDevice();

    expect(creds.deviceId).toBe("server-logical-device-id");
    const call = mockedFetch.mock.calls[0]!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.platform).toBe("ios");
    expect(typeof body.deviceFingerprint).toBe("string");
    expect(body.deviceFingerprint.length).toBeGreaterThan(8);
    expect(body.metadata?.credential_store).toBe("secure-storage");
  });

  test("propagates server error so caller can decide retry policy", async () => {
    mockedFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(ensureDevice()).rejects.toThrow(/devices\/register failed: 500/);
    expect(localStorage.getItem("pin.deviceToken")).toBeNull();
  });
});

describe("withDeviceHeaders", () => {
  test("adds X-Device-Id and X-Device-Token to headers when creds present", () => {
    const out = withDeviceHeaders(
      { "Content-Type": "application/json" },
      { deviceId: "d1", deviceToken: "t1", platform: "web" },
    );
    expect(out["X-Device-Id"]).toBe("d1");
    expect(out["X-Device-Token"]).toBe("t1");
    expect(out["Content-Type"]).toBe("application/json");
  });

  test("returns input unchanged when creds are null", () => {
    const out = withDeviceHeaders({ "Content-Type": "application/json" }, null);
    expect(out["X-Device-Id"]).toBeUndefined();
  });
});
