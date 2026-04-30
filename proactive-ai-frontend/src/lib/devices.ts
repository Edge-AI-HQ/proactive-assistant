/**
 * Device registration + token storage.
 *
 * On first launch the app generates a UUID v4 device id and exchanges
 * it for a long-lived token via POST /api/proactive/devices/register.
 * The token is stored locally and attached as X-Device-Id + X-Device-Token
 * to every POST /api/proactive/devices/ingest request, letting the cloud
 * route uploads to the correct user.
 *
 * See docs/plans/memory-architecture.mdx §三 (APIs user_devices).
 */
import { Capacitor } from "@capacitor/core";
import { proactiveFetch } from "./api";
import { API_BASE, isNative } from "./platform";

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
 * Attach device credentials to a Headers object for outgoing
 * /api/proactive/devices/ingest requests. The server now requires both
 * headers (no legacy default-container fallback), so any caller that
 * needs to ingest must provide credentials — this helper just spares
 * callers the typo-prone header keys.
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

// ── Ingest signals ───────────────────────────────────────────────────────

/**
 * One PersonalSignal in the wire format the server expects.
 * `id` and `occurred_at` will be filled in if the caller doesn't supply
 * them — most code paths just want to push a kind + summary and move on.
 */
export interface PersonalSignalInput {
  id?: string;
  source?: string;            // defaults to "device:<creds.deviceId>"
  kind: string;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  occurred_at?: string;       // ISO 8601, defaults to now()
  available_at?: string;
  expires_at?: string;
  salience?: number;
  confidence?: number;
  dedupe_key?: string;
}

export interface IngestResult {
  ok: boolean;
  accepted: number;
  inserted: number;
  ignored: number;
}

/**
 * Push a batch of PersonalSignals from this client up to the user's
 * OpenClaw container. Auth is the X-Device-Id + X-Device-Token PSK we
 * got back from /devices/register; the token never leaves the device.
 *
 * Caller-friendly: missing `id`s are auto-filled (UUID), missing
 * `source` defaults to "device:<deviceId>", missing `occurred_at`
 * defaults to now. The wire shape is the standard PersonalSignal
 * envelope (top-level array).
 */
export async function ingestSignals(
  creds: DeviceCredentials,
  items: PersonalSignalInput[],
): Promise<IngestResult> {
  if (items.length === 0) {
    return { ok: true, accepted: 0, inserted: 0, ignored: 0 };
  }
  const now = new Date().toISOString();
  const source = `device:${creds.deviceId}`;
  const wire = items.map((it) => ({
    id: it.id ?? generateDeviceId(), // UUID-ish; collision is fine, server dedupe_key wins
    source: it.source ?? source,
    kind: it.kind,
    title: it.title,
    summary: it.summary,
    payload: it.payload ?? {},
    occurred_at: it.occurred_at ?? now,
    ...(it.available_at ? { available_at: it.available_at } : {}),
    ...(it.expires_at ? { expires_at: it.expires_at } : {}),
    ...(typeof it.salience === "number" ? { salience: it.salience } : {}),
    ...(typeof it.confidence === "number" ? { confidence: it.confidence } : {}),
    ...(it.dedupe_key ? { dedupe_key: it.dedupe_key } : {}),
  }));

  const res = await fetch(`${API_BASE}/api/proactive/devices/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": creds.deviceId,
      "X-Device-Token": creds.deviceToken,
    },
    body: JSON.stringify(wire),
  });
  if (!res.ok) {
    if (res.status === 401) {
      // Stale token — drop the cache so next ensureDevice() re-registers.
      clearStored();
    }
    throw new Error(`/devices/ingest failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json();
}
