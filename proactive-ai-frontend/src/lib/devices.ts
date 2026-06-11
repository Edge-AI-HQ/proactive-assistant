/**
 * Device registration + token storage.
 *
 * On first launch the app generates a UUID v4 device id and exchanges
 * it for a long-lived token via POST /api/devices/register on
 * pinai-agents. Native clients persist the token in secure storage
 * (iOS Keychain / Android Keystore-backed storage) and attach it as
 * X-Device-Id + X-Device-Token to every POST /api/devices/ingest
 * request.
 */
import { Capacitor } from "@capacitor/core";
import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage";
import { userDevicesKeys } from "@pin-ai/state";
import { authHeaders } from "./api";
import { queryClient } from "./query-client";
import {
  isPinLocalDevAuthEnabled,
  PIN_LOCAL_DEV_AUTH_USER_ID,
} from "./dev-auth";
import { PIN_API_BASE, isNative, pinApiRequestHeaders } from "./platform";
import { supabase } from "./supabase";

const DEVICE_ID_KEY = "pin.deviceId";
const DEVICE_TOKEN_KEY = "pin.deviceToken";
const DEVICE_FINGERPRINT_KEY = "pin.deviceFingerprint";
const DEVICE_OWNER_KEY = "pin.deviceOwnerUserId";
let deviceRegistrationInFlight: {
  ownerUserId: string;
  promise: Promise<DeviceCredentials>;
} | null = null;

export type DevicePlatform = "ios" | "android" | "web";

export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
  platform: DevicePlatform;
}

export interface EnsureDeviceOptions {
  forceRefresh?: boolean;
}

interface StoredDeviceCredentials {
  deviceId: string | null;
  deviceToken: string | null;
  ownerUserId: string | null;
}

interface NativeDeviceProfile {
  deviceFingerprint: string | null;
  displayName: string;
  appVersion: string | null;
  model: string | null;
  metadata: Record<string, unknown>;
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

function readLocalStored(): StoredDeviceCredentials {
  try {
    return {
      deviceId: localStorage.getItem(DEVICE_ID_KEY),
      deviceToken: localStorage.getItem(DEVICE_TOKEN_KEY),
      ownerUserId: localStorage.getItem(DEVICE_OWNER_KEY),
    };
  } catch {
    return { deviceId: null, deviceToken: null, ownerUserId: null };
  }
}

function writeLocalStored(deviceId: string, deviceToken: string, ownerUserId: string): void {
  try {
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    localStorage.setItem(DEVICE_TOKEN_KEY, deviceToken);
    localStorage.setItem(DEVICE_OWNER_KEY, ownerUserId);
  } catch {
    // localStorage can throw in private mode; the device just won't be
    // remembered — next launch will re-register.
  }
}

function clearLocalStored(): void {
  try {
    localStorage.removeItem(DEVICE_ID_KEY);
    localStorage.removeItem(DEVICE_TOKEN_KEY);
    localStorage.removeItem(DEVICE_OWNER_KEY);
  } catch {
    /* ignore */
  }
}

async function readSecureValue(key: string): Promise<string | null> {
  // Pair with set() symmetrically: set() JSON-stringifies on write, get()
  // JSON-parses on read. Using getItem() (raw, no decode) here was the
  // bug — paired with set() it left a JSON-wrapper around every value,
  // and forceRefresh re-writes accumulated escape layers per cycle until
  // deviceId crossed the server's max_length=200 → 422.
  try {
    let v = await SecureStorage.get(key);
    if (typeof v !== "string") return null;
    // Self-heal legacy values written by the old asymmetric pair: peel
    // any remaining JSON-wrapping layers (one per past write cycle),
    // then re-save cleanly so subsequent reads are O(1).
    const original = v;
    while (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      try {
        const inner = JSON.parse(v);
        if (typeof inner !== "string") break;
        v = inner;
      } catch {
        break;
      }
    }
    if (v !== original) {
      try {
        await SecureStorage.set(
          key, v, false, false, KeychainAccess.afterFirstUnlockThisDeviceOnly,
        );
      } catch {
        // Best-effort cleanup write; reads still return the peeled value.
      }
    }
    return v;
  } catch {
    return null;
  }
}

async function writeSecureValue(key: string, value: string): Promise<void> {
  await SecureStorage.set(key, value, false, false, KeychainAccess.afterFirstUnlockThisDeviceOnly);
}

async function removeSecureValue(key: string): Promise<void> {
  try {
    await SecureStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

async function readStored(): Promise<StoredDeviceCredentials> {
  if (!isNative) return readLocalStored();

  const secureStored = {
    deviceId: await readSecureValue(DEVICE_ID_KEY),
    deviceToken: await readSecureValue(DEVICE_TOKEN_KEY),
    ownerUserId: await readSecureValue(DEVICE_OWNER_KEY),
  };
  if (secureStored.deviceId && secureStored.deviceToken && secureStored.ownerUserId) {
    return secureStored;
  }

  const legacyStored = readLocalStored();
  if (legacyStored.deviceId && legacyStored.deviceToken && legacyStored.ownerUserId) {
    await writeSecureValue(DEVICE_ID_KEY, legacyStored.deviceId);
    await writeSecureValue(DEVICE_TOKEN_KEY, legacyStored.deviceToken);
    await writeSecureValue(DEVICE_OWNER_KEY, legacyStored.ownerUserId);
    return legacyStored;
  }

  return secureStored.deviceId || secureStored.deviceToken || secureStored.ownerUserId
    ? secureStored
    : legacyStored;
}

async function writeStored(
  deviceId: string,
  deviceToken: string,
  ownerUserId: string,
): Promise<void> {
  if (!isNative) {
    writeLocalStored(deviceId, deviceToken, ownerUserId);
    return;
  }
  await writeSecureValue(DEVICE_ID_KEY, deviceId);
  await writeSecureValue(DEVICE_TOKEN_KEY, deviceToken);
  await writeSecureValue(DEVICE_OWNER_KEY, ownerUserId);
}

async function clearStored(): Promise<void> {
  if (!isNative) {
    clearLocalStored();
    return;
  }
  clearLocalStored();
  await removeSecureValue(DEVICE_ID_KEY);
  await removeSecureValue(DEVICE_TOKEN_KEY);
  await removeSecureValue(DEVICE_OWNER_KEY);
}

async function ensureDeviceFingerprint(): Promise<string | null> {
  if (!isNative) return null;
  const stored = await readSecureValue(DEVICE_FINGERPRINT_KEY);
  if (stored) return stored;
  const next = generateDeviceId();
  await writeSecureValue(DEVICE_FINGERPRINT_KEY, next);
  return next;
}

function cleanDevicePart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildHardwareSignature(
  platform: DevicePlatform,
  info: Record<string, unknown> | null,
): string | null {
  if (!info) return null;
  const model = cleanDevicePart(info.model);
  if (!model) return null;
  const manufacturer = cleanDevicePart(info.manufacturer);
  const physical = info.isVirtual === true ? "virtual" : "physical";
  return [
    "hardware-v1",
    platform,
    manufacturer ?? "unknown-manufacturer",
    model,
    physical,
  ].join(":");
}

async function getNativeDeviceProfile(platform: DevicePlatform): Promise<NativeDeviceProfile> {
  if (!isNative) {
    return {
      deviceFingerprint: null,
      displayName: "Web",
      appVersion: null,
      model: null,
      metadata: {},
    };
  }

  let info: Record<string, unknown> | null = null;
  let appVisibleId: string | null = null;
  try {
    const { Device } = await import("@capacitor/device");
    const [deviceInfo, deviceId] = await Promise.all([
      Device.getInfo(),
      Device.getId(),
    ]);
    info = deviceInfo as unknown as Record<string, unknown>;
    appVisibleId = cleanDevicePart(deviceId.identifier);
  } catch {
    info = null;
    appVisibleId = null;
  }

  let appVersion: string | null = null;
  try {
    const { App } = await import("@capacitor/app");
    const appInfo = await App.getInfo();
    appVersion = cleanDevicePart(appInfo.version) ?? cleanDevicePart(appInfo.build);
  } catch {
    appVersion = null;
  }

  const storedFallback = await ensureDeviceFingerprint();
  const hardwareSignature = buildHardwareSignature(platform, info);
  const model = cleanDevicePart(info?.model);
  const displayName = cleanDevicePart(info?.name)
    ?? `${platform[0]?.toUpperCase()}${platform.slice(1)} app`;

  return {
    deviceFingerprint: appVisibleId
      ? `capacitor-device-id-v1:${appVisibleId}`
      : storedFallback,
    displayName,
    appVersion,
    model,
    metadata: {
      credential_store: "secure-storage",
      device_fingerprint_source: appVisibleId
        ? "capacitor-device-id-v1"
        : "secure-storage-uuid",
      ...(hardwareSignature ? { hardware_signature: hardwareSignature } : {}),
      ...(cleanDevicePart(info?.manufacturer) ? { manufacturer: cleanDevicePart(info?.manufacturer) } : {}),
      ...(typeof info?.isVirtual === "boolean" ? { is_virtual: info.isVirtual } : {}),
      ...(cleanDevicePart(info?.osVersion) ? { os_version: cleanDevicePart(info?.osVersion) } : {}),
    },
  };
}

interface RegisterResponse {
  // pinai-agents shape: flat object with camelCase + the secret token.
  deviceId: string;
  deviceToken: string;
  platform: DevicePlatform;
  registeredAt: string;
}

async function currentUserId(): Promise<string> {
  if (isPinLocalDevAuthEnabled()) return PIN_LOCAL_DEV_AUTH_USER_ID;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("device registration requires an authenticated user");
  }
  return userId;
}

export async function currentDeviceOwnerUserId(): Promise<string | null> {
  try {
    return await currentUserId();
  } catch {
    return null;
  }
}

async function isCurrentOwner(ownerUserId: string): Promise<boolean> {
  try {
    return (await currentUserId()) === ownerUserId;
  } catch {
    return false;
  }
}

function emitDeviceRegistered(_creds: DeviceCredentials): void {
  // 设备注册后让所有 useUserDevices 实例重拉。迁移前靠 window 的
  // DEVICE_REGISTERED_EVENT 自制事件广播；TQ cache 共享后 invalidate
  // 即全员同步（分层 Phase 2，事件机制随 device-events.ts 一并删除）。
  void queryClient.invalidateQueries({ queryKey: userDevicesKeys.all });
}

async function registerDeviceForUser(
  platform: DevicePlatform,
  ownerUserId: string,
  proposedDeviceId: string,
): Promise<DeviceCredentials> {
  const profile = await getNativeDeviceProfile(platform);

  const postRegister = async (deviceId: string) =>
    fetch(`${PIN_API_BASE}/api/devices/register`, {
      method: "POST",
      headers: pinApiRequestHeaders({
        ...(await authHeaders()),
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        deviceId,
        platform,
        displayName: profile.displayName,
        ...(profile.appVersion ? { appVersion: profile.appVersion } : {}),
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.deviceFingerprint ? { deviceFingerprint: profile.deviceFingerprint } : {}),
        metadata: profile.metadata,
      }),
    });

  let res = await postRegister(proposedDeviceId);
  if (res.status === 409) {
    // The stored deviceId can belong to a previous account on the same
    // phone. Keep the hardware fingerprint, but propose a fresh logical id.
    res = await postRegister(generateDeviceId());
  }
  if (!res.ok) {
    throw new Error(`/devices/register failed: ${res.status}`);
  }
  const data = (await res.json()) as RegisterResponse;
  const creds = {
    deviceId: data.deviceId,
    deviceToken: data.deviceToken,
    platform,
  };
  if (await isCurrentOwner(ownerUserId)) {
    await writeStored(data.deviceId, data.deviceToken, ownerUserId);
    emitDeviceRegistered(creds);
  }
  return creds;
}

function registerDeviceForUserOnce(
  platform: DevicePlatform,
  ownerUserId: string,
  proposedDeviceId: string,
): Promise<DeviceCredentials> {
  if (deviceRegistrationInFlight?.ownerUserId === ownerUserId) {
    return deviceRegistrationInFlight.promise;
  }
  const promise = registerDeviceForUser(
    platform,
    ownerUserId,
    proposedDeviceId,
  ).finally(() => {
    if (deviceRegistrationInFlight?.promise === promise) {
      deviceRegistrationInFlight = null;
    }
  });
  deviceRegistrationInFlight = { ownerUserId, promise };
  return promise;
}

/**
 * Ensure this client has a registered device + token. If we already have
 * both stored, returns them immediately. Otherwise registers a new device
 * with the cloud and persists the returned token.
 *
 * Called once on app boot after sign-in, and again before the first mobile
 * sync. Credentials are scoped to the Supabase user so account switching on
 * the same phone does not reuse another user's device token.
 */
export async function ensureDevice(
  opts: EnsureDeviceOptions = {},
): Promise<DeviceCredentials> {
  const platform = detectPlatform();
  const ownerUserId = await currentUserId();
  if (deviceRegistrationInFlight?.ownerUserId === ownerUserId) {
    return deviceRegistrationInFlight.promise;
  }
  const {
    deviceId: storedId,
    deviceToken: storedToken,
    ownerUserId: storedOwner,
  } = await readStored();
  if (!opts.forceRefresh && storedId && storedToken && storedOwner === ownerUserId) {
    return { deviceId: storedId, deviceToken: storedToken, platform };
  }

  const deviceId = storedId ?? generateDeviceId();
  return registerDeviceForUserOnce(platform, ownerUserId, deviceId);
}

/**
 * Attach device credentials to a Headers object for outgoing
 * /api/devices/ingest requests. The server requires both headers, so
 * any caller that needs to ingest must provide credentials — this
 * helper just spares callers the typo-prone header keys.
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

export async function clearDeviceCredentials(): Promise<void> {
  await clearStored();
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
  sync_mode?: "incremental" | "full";
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

/**
 * Server-side per-item status. Five states; outbox must handle each:
 *   inserted | duplicate     → success, drop from queue
 *   rejected | parse_failed  → permanent failure, drop + log
 *   retryable_failed         → transient server-side failure, keep + retry
 * Contract owner: pinai-agents `/api/devices/ingest`. See
 * docs/plans/2026-05-12-v2-to-v3-migration.mdx for rationale.
 */
export type IngestItemStatus =
  | "inserted"
  | "duplicate"
  | "rejected"
  | "parse_failed"
  | "retryable_failed";

export interface IngestItemResult {
  id: string;
  dedupeKey: string | null;
  status: IngestItemStatus;
  reason?: string;
}

export interface IngestResult {
  ok: boolean;
  accepted: number;
  inserted: number;
  ignored: number;
  results?: IngestItemResult[];
}

/**
 * Push a batch of PersonalSignals from this client up to pinai-agents.
 * Auth is the X-Device-Id + X-Device-Token PSK we got back from
 * /api/devices/register; the token never leaves the device.
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
  const initialSource = `device:${creds.deviceId}`;
  const normalized = items.map((it) => ({
    ...it,
    id: it.id ?? generateDeviceId(), // UUID-ish; collision is fine, server dedupe_key wins
  }));
  const buildWire = (activeCreds: DeviceCredentials) => normalized.map((it) => ({
    id: it.id,
    source: !it.source || it.source === initialSource
      ? `device:${activeCreds.deviceId}`
      : it.source,
    kind: it.kind,
    ...(it.sync_mode ? { sync_mode: it.sync_mode } : {}),
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

  const post = (activeCreds: DeviceCredentials) =>
    fetch(`${PIN_API_BASE}/api/devices/ingest`, {
      method: "POST",
      headers: pinApiRequestHeaders({
        "Content-Type": "application/json",
        "X-Device-Id": activeCreds.deviceId,
        "X-Device-Token": activeCreds.deviceToken,
      }),
      body: JSON.stringify(buildWire(activeCreds)),
    });

  let res = await post(creds);
  if (res.status === 401) {
    await clearStored();
    const freshCreds = await ensureDevice();
    res = await post(freshCreds);
  }
  if (!res.ok) {
    if (res.status === 401) {
      // Stale token persisted even after retry; force a fresh registration on
      // the next scheduler cycle.
      await clearStored();
    }
    throw new Error(`/devices/ingest failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json();
}
