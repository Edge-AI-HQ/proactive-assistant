/**
 * Tests for the device registration helper.
 * Mocks global fetch + secure storage to isolate the SDK contract from
 * the network. The endpoint is /api/devices/register on pinai-agents
 * (no longer /api/proactive/devices/register on legacy apis).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  clearDeviceCredentials,
  ensureDevice,
  withDeviceHeaders,
} from "./devices";

const { platformState, secureStore, devicePluginState, appPluginState } = vi.hoisted(() => ({
  platformState: { isNative: false, platform: "web" },
  secureStore: new Map<string, string>(),
  devicePluginState: {
    identifier: "ios-vendor-visible-id",
    info: {
      name: "Smile's iPhone",
      model: "iPhone15,3",
      platform: "ios",
      operatingSystem: "ios",
      osVersion: "18.5",
      manufacturer: "Apple",
      isVirtual: false,
    },
  },
  appPluginState: {
    info: {
      version: "1.2.3",
      build: "456",
    },
  },
}));

vi.mock("./api", () => ({
  authHeaders: vi.fn(async () => ({})),
}));
vi.mock("./platform", () => ({
  PIN_API_BASE: "",
  get isNative() {
    return platformState.isNative;
  },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platformState.platform },
}));
vi.mock("@capacitor/device", () => ({
  Device: {
    getId: vi.fn(async () => ({ identifier: devicePluginState.identifier })),
    getInfo: vi.fn(async () => devicePluginState.info),
  },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    getInfo: vi.fn(async () => appPluginState.info),
  },
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

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

describe("ensureDevice", () => {
  beforeEach(() => {
    platformState.isNative = false;
    platformState.platform = "web";
    secureStore.clear();
    localStorage.clear();
    fetchMock.mockReset();
  });

  afterEach(async () => {
    await clearDeviceCredentials();
  });

  test("registers a new device on first call and persists the token", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        deviceId: "any-id-server-canonical",
        deviceToken: "secret-token-once",
        platform: "web",
        registeredAt: new Date().toISOString(),
      }),
    });

    const creds = await ensureDevice();
    expect(creds.deviceToken).toBe("secret-token-once");
    expect(creds.deviceId).toBe("any-id-server-canonical");
    expect(localStorage.getItem("pin.deviceId")).toBe("any-id-server-canonical");
    expect(localStorage.getItem("pin.deviceToken")).toBe("secret-token-once");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("/api/devices/register");
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
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("native registration sends a stable fingerprint for server-side dedupe", async () => {
    platformState.isNative = true;
    platformState.platform = "ios";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        deviceId: "server-logical-device-id",
        deviceToken: "secret-token-once",
        platform: "ios",
        registeredAt: new Date().toISOString(),
      }),
    });

    const creds = await ensureDevice();

    expect(creds.deviceId).toBe("server-logical-device-id");
    const call = fetchMock.mock.calls[0]!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.platform).toBe("ios");
    expect(body.displayName).toBe("Smile's iPhone");
    expect(body.appVersion).toBe("1.2.3");
    expect(body.model).toBe("iPhone15,3");
    expect(body.deviceFingerprint).toBe("capacitor-device-id-v1:ios-vendor-visible-id");
    expect(body.metadata?.credential_store).toBe("secure-storage");
    expect(body.metadata?.device_fingerprint_source).toBe("capacitor-device-id-v1");
    expect(body.metadata?.hardware_signature).toContain("iPhone15,3");
    expect(body.metadata?.hardware_signature).not.toContain("Smile's iPhone");
  });

  test("propagates server error so caller can decide retry policy", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
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
