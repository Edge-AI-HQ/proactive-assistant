import { readErrorMessage } from "../transport/errors";
import { pinaiFetch, proxyFetch } from "../transport/http";
import type { PersonalSignal } from "./profile";

// ── User devices (multi-device registry) ──

export type UserDevicePlatform =
  | "ios" | "android" | "web"
  | "wearable" | "sensor" | "embedded";

export interface UserDevice {
  device_id: string;
  platform: UserDevicePlatform;
  display_name: string | null;
  app_version: string | null;
  model: string | null;
  registered_at: string;
  last_seen_at: string | null;
  status: "active" | "revoked";
  metadata: Record<string, unknown>;
  aliased_device_ids?: string[];
}

export interface RegisterDeviceInput {
  deviceId: string;
  platform: UserDevicePlatform;
  displayName?: string | null;
  appVersion?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}

export async function listUserDevices(): Promise<UserDevice[]> {
  const res = await pinaiFetch("/api/devices/list");
  if (!res.ok) throw new Error(`/devices/list failed: ${await readErrorMessage(res)}`);
  // pinai-agents returns { items: [...] } with camelCase fields; normalize
  // back to the snake_case UserDevice shape callers expect.
  const data = (await res.json()) as {
    items?: Array<{
      deviceId: string;
      platform: UserDevicePlatform;
      displayName: string | null;
      appVersion: string | null;
      model: string | null;
      registeredAt: string;
      lastSeenAt: string | null;
      status: "active" | "revoked";
      metadata?: Record<string, unknown>;
      aliasedDeviceIds?: string[];
    }>;
  };
  return (data.items ?? []).map((d) => ({
    device_id: d.deviceId,
    platform: d.platform,
    display_name: d.displayName,
    app_version: d.appVersion,
    model: d.model,
    registered_at: d.registeredAt,
    last_seen_at: d.lastSeenAt,
    status: d.status,
    metadata: d.metadata ?? {},
    aliased_device_ids: d.aliasedDeviceIds ?? [d.deviceId],
  }));
}

export async function registerUserDevice(
  input: RegisterDeviceInput,
): Promise<{ device: UserDevice; deviceToken: string }> {
  const res = await pinaiFetch("/api/devices/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`/devices/register failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as {
    deviceId: string;
    deviceToken: string;
    platform: UserDevicePlatform;
    registeredAt: string;
  };
  return {
    device: {
      device_id: data.deviceId,
      platform: data.platform,
      display_name: input.displayName ?? null,
      app_version: input.appVersion ?? null,
      model: input.model ?? null,
      registered_at: data.registeredAt,
      last_seen_at: null,
      status: "active",
      metadata: input.metadata ?? {},
    },
    deviceToken: data.deviceToken,
  };
}

export type PushProvider = "apns" | "fcm" | "web";

/**
 * Upsert the APNs/FCM/web push token for a registered device. Idempotent:
 * the server resets push_failure_count to 0 on every successful call, so
 * re-registering a previously-soft-disabled token revives it in place.
 *
 * Called by usePushNotifications on every native registration event —
 * Apple may rotate the token, so each app launch's PUT keeps us current.
 */
export async function setDevicePushToken(
  deviceId: string,
  pushToken: string,
  pushProvider: PushProvider,
): Promise<void> {
  const res = await pinaiFetch(
    `/api/devices/${encodeURIComponent(deviceId)}/push-token`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushToken, pushProvider }),
    },
  );
  if (!res.ok) {
    throw new Error(`/devices/{id}/push-token failed: ${await readErrorMessage(res)}`);
  }
}

/**
 * Debug: schedule a notification 5s in the future. Lets the developer
 * background the app and verify the banner arrives via APNs (not just
 * via the in-app foreground event surface). Returns the server-confirmed
 * delay so callers can show a countdown.
 */
export async function scheduleTestPush(): Promise<{ scheduledInSeconds: number }> {
  const res = await pinaiFetch("/api/devices/test-push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`/devices/test-push failed: ${await readErrorMessage(res)}`);
  }
  const data = (await res.json()) as { scheduledInSeconds?: number };
  return { scheduledInSeconds: data.scheduledInSeconds ?? 5 };
}

export async function revokeUserDevice(deviceId: string): Promise<void> {
  const res = await pinaiFetch("/api/devices/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) throw new Error(`/devices/revoke failed: ${await readErrorMessage(res)}`);
}

/**
 * Fetch a TTL-bounded signed URL for a device-uploaded media blob.
 * The path is the storage_path stored on personal_signals.payload.
 * Returns null when storage isn't configured (dev without Supabase
 * Storage); UI should render a placeholder.
 */
export async function deviceMediaUrl(storagePath: string): Promise<string | null> {
  const res = await pinaiFetch(`/api/devices/media/${storagePath}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { signedUrl?: string };
  return data.signedUrl ?? null;
}

// ── Device unified timeline ───────────────────────────────────────────

export interface DeviceHealthObservation {
  id: string;
  device_id: string;
  observation_type: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  start_at: string | null;
  end_at: string | null;
  local_date: string | null;
  source_app: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
}

export type DeviceTimelineItem =
  | { type: "signal"; occurred_at: string; row: PersonalSignal }
  | { type: "health"; occurred_at: string; row: DeviceHealthObservation };

export interface DeviceTimelineResponse {
  ok: boolean;
  items: DeviceTimelineItem[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Unified device timeline (signals + raw health observations) ordered
 * by ``occurred_at DESC`` with a single keyset cursor. Backed by
 * `GET /api/devices/{deviceId}/timeline`.
 */
export async function fetchDeviceTimeline(
  deviceId: string,
  opts: { before?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<DeviceTimelineResponse> {
  const qs = new URLSearchParams();
  if (opts.before) qs.set("before", opts.before);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(
    `/devices/${encodeURIComponent(deviceId)}/timeline${suffix}`,
    { signal: opts.signal },
  );
  if (!res.ok) {
    throw new Error(
      `/devices/${deviceId}/timeline failed: ${await readErrorMessage(res)}`,
    );
  }
  const data = (await res.json()) as Partial<DeviceTimelineResponse>;
  return {
    ok: data.ok ?? false,
    items: Array.isArray(data.items) ? data.items : [],
    next_cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    has_more: data.has_more ?? false,
  };
}
