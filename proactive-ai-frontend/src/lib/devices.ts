/**
 * Device registration + token storage.
 *
 * On first launch the app generates a UUID v4 device id and exchanges
 * it for a long-lived token via POST /api/proactive/devices/register.
 * The token is stored locally and attached as X-Device-Id + X-Device-Token
 * to every /api/mobile/* request, letting the cloud route uploads to the
 * correct user (vs the legacy "default mobile container" lookup).
 *
 * See docs/memory-architecture.md §三 (APIs user_devices).
 */
import { Capacitor } from "@capacitor/core";
import { proactiveFetch } from "./api";
import { isNative } from "./platform";

const DEVICE_ID_KEY = "pin.deviceId";
const DEVICE_TOKEN_KEY = "pin.deviceToken";

export type DevicePlatform = "ios" | "android" | "web";

export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
  platform: DevicePlatform;
}

function detectPlatform(): DevicePlatform {
  const p = Capacitor.getPlatform();          // "ios" | "android" | "web"
  if (p === "ios" || p === "android") return p;
  return "web";
}

function generateDeviceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: time + random hex; only used in pathological older WebViews.
  const rand = Math.random().toString(16).slice(2);
  return `dev-${Date.now().toString(36)}-${rand}`;
}

function readStored(): { deviceId: string | null; deviceToken: string | null } {
  try {
    return {
      deviceId: localStorage.getItem(DEVICE_ID_KEY),
      deviceToken: localStorage.getItem(DEVICE_TOKEN_KEY),
    };
  } catch {
    return { deviceId: null, deviceToken: null };
  }
}

function writeStored(deviceId: string, deviceToken: string): void {
  try {
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    localStorage.setItem(DEVICE_TOKEN_KEY, deviceToken);
  } catch {
    // localStorage can throw in private mode; the device just won't be
    // remembered — next launch will re-register.
  }
}

function clearStored(): void {
  try {
    localStorage.removeItem(DEVICE_ID_KEY);
    localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

interface RegisterResponse {
  ok: boolean;
  device: { device_id: string; platform: DevicePlatform };
  device_token: string;
}

/**
 * Ensure this client has a registered device + token. If we already have
 * both stored, returns them immediately. Otherwise registers a new device
 * with the cloud and persists the returned token.
 *
 * Called once on app boot (after sign-in, before the first mobile sync).
 */
export async function ensureDevice(): Promise<DeviceCredentials> {
  const platform = detectPlatform();
  const { deviceId: storedId, deviceToken: storedToken } = readStored();
  if (storedId && storedToken) {
    return { deviceId: storedId, deviceToken: storedToken, platform };
  }

  const deviceId = storedId ?? generateDeviceId();
  const displayName = isNative
    ? `${platform[0]?.toUpperCase()}${platform.slice(1)} app`
    : "Web";

  const res = await proactiveFetch("/api/proactive/devices/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, platform, displayName }),
  });
  if (!res.ok) {
    throw new Error(`/devices/register failed: ${res.status}`);
  }
  const data = (await res.json()) as RegisterResponse;
  writeStored(data.device.device_id, data.device_token);
  return {
    deviceId: data.device.device_id,
    deviceToken: data.device_token,
    platform,
  };
}

/**
 * Attach device credentials to a Headers object for outgoing /api/mobile/*
 * requests. Falls back to a no-op when no credentials are stored — the
 * legacy default-container path on the server will still work.
 */
export function withDeviceHeaders(
  base: Record<string, string>,
  creds: DeviceCredentials | null,
): Record<string, string> {
  if (!creds) return base;
  return {
    ...base,
    "X-Device-Id": creds.deviceId,
    "X-Device-Token": creds.deviceToken,
  };
}

export function clearDeviceCredentials(): void {
  clearStored();
}
