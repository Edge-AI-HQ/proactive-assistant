/**
 * API client for the proactive-ai cloud service.
 *
 * All calls go through the APIs reverse proxy:
 *   /api/proactive/*   → APIs endpoints (auth, container management)
 *   /api/proxy/*       → user's container (pipeline, chat, etc.)
 *
 * Auth: Supabase JWT is attached automatically via getAccessToken().
 */

import { supabase } from "./supabase";
import { API_BASE } from "./platform";

export interface Goal {
  id: string;
  user_id: string;
  key: string;
  title: string;
  priority: string;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRecord {
  id: string;
  user_id: string;
  display_name: string;
  locale: string;
  timezone: string;
  summary: string | null;
  facts: Record<string, unknown>;
  preferences: Record<string, unknown>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ProfileMemory {
  id: string;
  user_id: string;
  kind: string;
  text: string;
  tags: string[];
  created_at: string;
}

export interface ProfileSignal {
  id: string;
  user_id: string;
  kind: string;
  target_type: string;
  target_key: string;
  value: number | null;
  source: string | null;
  context: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
}

export type PersonalSignalStatus = "open" | "consumed" | "archived";

export interface PersonalSignal {
  id: string;
  kind: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  source: string;
  device_id: string | null;
  subject: string | null;
  salience: number;
  confidence: number;
  status: PersonalSignalStatus;
  dedupe_key: string | null;
  occurred_at: string;
  available_at: string;
  expires_at: string | null;
  ingested_at: string;
  consumed_at: string | null;
  consumed_by_run_id: string | null;
  source_raw_table: string | null;
  source_raw_ids: string[];
  referenced_by_runs: string[];
}

export interface SignalListFilter {
  /** 'all' bypasses the server-side status filter (timeline view). */
  status?: PersonalSignalStatus | "all";
  kind?: string;
  source?: string;
  deviceId?: string;
  since?: string;
  until?: string;
  minSalience?: number;
  limit?: number;
  offset?: number;
  /**
   * Keyset cursor returned in `next_cursor`. Prefer this over `offset` for
   * timelines — it stays O(limit) regardless of how many pages back you go.
   */
  before?: string;
  pruneExpired?: boolean;
}

export interface SignalListResponse {
  ok: boolean;
  signals: PersonalSignal[];
  /** -1 when paginating by cursor (server skips the COUNT). */
  total: number;
  next_cursor: string | null;
  has_more: boolean;
}

export interface ProfileInterest {
  id: string;
  user_id: string;
  kind: string;
  key: string;
  score: number;
  confidence: number;
  evidence_count: number;
  status: string;
  last_signal_at: string | null;
}

export interface ProfileSnapshot {
  profile: ProfileRecord | null;
  goals: Goal[];
  memories: ProfileMemory[];
  signals: ProfileSignal[];
  interests: ProfileInterest[];
}

async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status}`;

    try {
      const data = JSON.parse(text) as { error?: unknown };
      // New shape: { error: { code, message } } — Stripe / Google Cloud convention.
      if (data?.error && typeof data.error === "object" && data.error !== null) {
        const obj = data.error as { code?: unknown; message?: unknown };
        if (typeof obj.message === "string" && obj.message.trim()) {
          return `${res.status} ${obj.message}`;
        }
      }
      // Legacy shape: { error: "string" }.
      if (typeof data?.error === "string" && data.error.trim()) {
        return `${res.status} ${data.error}`;
      }
    } catch {
      // Fall back to the raw response text when the body is not JSON.
    }

    return `${res.status} ${text}`;
  } catch {
    return `${res.status}`;
  }
}

/**
 * Refresh the Supabase session and return a fresh access token.
 * Returns null if refresh fails (user should be signed out).
 */
async function refreshAndGetToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) return null;
  return data.session.access_token;
}

export async function proactiveFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status !== 401) return res;

  const freshToken = await refreshAndGetToken();
  if (!freshToken) return res;

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...headers,
      Authorization: `Bearer ${freshToken}`,
    },
  });
}

// ── APIs endpoints (/api/proactive/*) ──

export async function heartbeat(): Promise<void> {
  await proactiveFetch("/api/proactive/user/heartbeat", {
    method: "POST",
  });
}

export async function ensureContainer(): Promise<{
  containerId: string;
  ready: boolean;
  status: string;
}> {
  const res = await proactiveFetch("/api/proactive/container/ensure", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/container/ensure failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function resetContainer(): Promise<{ ok: boolean; containerId: string; ready: boolean }> {
  const res = await proactiveFetch("/api/proactive/container/reset", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/container/reset failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function destroyContainer(): Promise<{ ok: boolean }> {
  const res = await proactiveFetch("/api/proactive/container/destroy", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/container/destroy failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchContainerStatus(): Promise<{
  status: string;
  created_at?: string;
}> {
  const res = await proactiveFetch("/api/proactive/container/status");
  if (!res.ok) throw new Error(`/container/status failed: ${await readErrorMessage(res)}`);
  return res.json();
}

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
  const res = await proactiveFetch("/api/proactive/devices");
  if (!res.ok) throw new Error(`/devices list failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as { devices?: UserDevice[] };
  return Array.isArray(data.devices) ? data.devices : [];
}

export async function registerUserDevice(
  input: RegisterDeviceInput,
): Promise<{ device: UserDevice; deviceToken: string }> {
  const res = await proactiveFetch("/api/proactive/devices/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`/devices/register failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as {
    device: UserDevice;
    device_token?: string;
    deviceToken?: string;
  };
  const token = data.device_token ?? data.deviceToken ?? "";
  return { device: data.device, deviceToken: token };
}

export async function revokeUserDevice(deviceId: string): Promise<void> {
  const res = await proactiveFetch("/api/proactive/devices/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) throw new Error(`/devices/revoke failed: ${await readErrorMessage(res)}`);
}

// ── Pair Code (RFC 8628 simplified) ──

export interface PairCodeClaimResult {
  device_id: string;
  display_name: string;
  device_token: string;
}

/**
 * The Web user enters the 6-char code shown on the device, optionally with
 * a friendly display_name + model. On success the pairing_codes row flips
 * to 'claimed', a user_devices row is created for this user, and a
 * one-shot token is stashed for the device's next poll.
 */
export async function claimPairCode(
  code: string,
  displayName?: string,
  model?: string,
): Promise<PairCodeClaimResult> {
  const trimmed = code.trim().toUpperCase();
  const res = await proactiveFetch("/api/proactive/devices/pair-code/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: trimmed,
      ...(displayName ? { displayName } : {}),
      ...(model ? { model } : {}),
    }),
  });
  if (!res.ok) {
    // Surface the domain error code so the UI can render specific copy
    // ("code expired", "already claimed", etc.) instead of a generic message.
    let detail: { error?: string; code?: string } = {};
    try { detail = await res.json(); } catch { /* keep empty */ }
    const e = new Error(detail.error ?? `pair-code claim failed: ${res.status}`) as Error & { domainCode?: string; status?: number };
    e.domainCode = detail.code;
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * Build a URL to fetch a device-uploaded media blob through the APIs proxy.
 * The container exposes GET /devices/media/<rel-path>; the path stored on
 * personal_signals.payload.file_path is exactly the rel-path we need.
 */
export function deviceMediaUrl(filePath: string): string {
  return `${API_BASE}/api/proxy/devices/media/${filePath}`;
}

// ── Account deletion ──

export async function deleteAccount(): Promise<void> {
  const res = await proactiveFetch("/api/proactive/user/delete", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/user/delete failed: ${await readErrorMessage(res)}`);
}

// ── Model management ──

export interface ModelOption {
  id: string;
  ref: string;
}

export interface ModelsResponse {
  ok: boolean;
  current_model: string;
  default_model: string;
  available_models: ModelOption[];
}

export type GatewayProbeCode =
  | "NO_CONTAINER"
  | "PROXY_ERROR"
  | "RESUMING"
  | "CONTAINER_NOT_RUNNING";

export interface GatewayProbeResult {
  ok: boolean;
  httpStatus: number | null;
  code?: GatewayProbeCode;
  message?: string;
}

function toGatewayProbeCode(value: unknown): GatewayProbeCode | undefined {
  switch (value) {
    case "NO_CONTAINER":
    case "PROXY_ERROR":
    case "RESUMING":
    case "CONTAINER_NOT_RUNNING":
      return value;
    default:
      return undefined;
  }
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelsResponse> {
  const res = await proactiveFetch("/api/proactive/models", { signal });
  if (!res.ok) throw new Error(`/models failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function changeModel(
  modelRef: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; model: string }> {
  const res = await proactiveFetch("/api/proactive/models/change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelRef }),
    signal,
  });
  if (!res.ok) throw new Error(`/models/change failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── Gateway ticket ──

export async function getGatewayTicket(): Promise<{
  ticket: string;
  expiresIn: number;
  url: string;
}> {
  const res = await proactiveFetch("/api/proactive/gateway/ticket", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/gateway/ticket failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── Gateway readiness probe ──

export async function probeGatewayHealth(): Promise<GatewayProbeResult> {
  try {
    const res = await fetch(`${API_BASE}/api/proxy/health`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = await res.json();
      data =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      data = null;
    }

    const message =
      typeof data?.error === "string"
        ? data.error
        : typeof data?.message === "string"
          ? data.message
          : undefined;
    const code = toGatewayProbeCode(data?.code);

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        code,
        message: message || res.statusText || "Gateway health check failed",
      };
    }

    return {
      ok: typeof data?.ok === "boolean" ? data.ok : true,
      httpStatus: res.status,
      code,
      message,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      message: error instanceof Error ? error.message : "Gateway health check failed",
    };
  }
}

// ── Container proxy endpoints (/api/proxy/*) ──

/**
 * Fetch via the container proxy.  Automatically retries once on 401
 * after refreshing the Supabase session token.
 */
export async function proxyFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${API_BASE}/api/proxy${path}`, { ...init, headers });

  // Retry once with a refreshed token on 401
  if (res.status === 401) {
    const freshToken = await refreshAndGetToken();
    if (freshToken) {
      const retryHeaders: Record<string, string> = {
        ...headers,
        Authorization: `Bearer ${freshToken}`,
      };
      return fetch(`${API_BASE}/api/proxy${path}`, { ...init, headers: retryHeaders });
    }
  }

  return res;
}

export async function proxyPost(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  return proxyFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function fetchProfileSnapshot(
  signal?: AbortSignal
): Promise<ProfileSnapshot> {
  const res = await proxyFetch("/profile", { signal });
  if (!res.ok) throw new Error(`/profile failed: ${res.status}`);

  const data = await res.json();
  return {
    profile: data?.profile ?? null,
    goals: Array.isArray(data?.goals) ? data.goals : [],
    memories: Array.isArray(data?.memories) ? data.memories : [],
    signals: Array.isArray(data?.signals) ? data.signals : [],
    interests: Array.isArray(data?.interests) ? data.interests : [],
  };
}

export async function fetchSignals(
  filter?: SignalListFilter,
  signal?: AbortSignal,
): Promise<SignalListResponse> {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.kind) qs.set("kind", filter.kind);
  if (filter?.source) qs.set("source", filter.source);
  if (filter?.deviceId) qs.set("deviceId", filter.deviceId);
  if (filter?.since) qs.set("since", filter.since);
  if (filter?.until) qs.set("until", filter.until);
  if (typeof filter?.minSalience === "number") qs.set("minSalience", String(filter.minSalience));
  if (filter?.limit) qs.set("limit", String(filter.limit));
  if (typeof filter?.offset === "number") qs.set("offset", String(filter.offset));
  if (filter?.before) qs.set("before", filter.before);
  if (filter?.pruneExpired) qs.set("pruneExpired", "1");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/signals${suffix}`, { signal });
  if (!res.ok) throw new Error(`/signals failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as Partial<SignalListResponse>;
  return {
    ok: data.ok ?? false,
    signals: Array.isArray(data.signals) ? data.signals : [],
    total: typeof data.total === "number" ? data.total : -1,
    next_cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    has_more: data.has_more ?? false,
  };
}

export interface RawListFilter {
  since?: string;
  until?: string;
  limit?: number;
}

export interface GmailMessage {
  id: string;
  message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string | null;
  snippet: string | null;
  body: string | null;
  label_ids: string[];
  internal_date: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface GcalEvent {
  id: string;
  calendar_id: string;
  event_id: string;
  title: string | null;
  description: string | null;
  location: string | null;
  start_at: string | null;
  end_at: string | null;
  attendees: string[];
  status: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface DeviceAppRaw {
  id: string;
  snapshot_id: string;
  device_id: string;
  bundle_id: string;
  app_name: string;
  version: string | null;
  last_used_at: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface DeviceContactRaw {
  id: string;
  snapshot_id: string;
  device_id: string;
  display_name: string | null;
  emails: string[];
  phones: string[];
  last_modified: string | null;
  occurred_at: string;
  ingested_at: string;
  dedupe_key: string | null;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface DeviceHealthRaw {
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
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

function rawQuery(params?: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "boolean") {
      if (value) qs.set(key, "1");
    } else {
      qs.set(key, String(value));
    }
  }
  return qs.toString() ? `?${qs.toString()}` : "";
}

export async function fetchRawGmail(
  filter?: RawListFilter & { threadId?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; messages: GmailMessage[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    threadId: filter?.threadId,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/gmail${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/gmail failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchRawGcal(
  filter?: RawListFilter & { calendarId?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; events: GcalEvent[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    calendarId: filter?.calendarId,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/gcal${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/gcal failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchRawDeviceApps(
  filter?: RawListFilter & { deviceId?: string; snapshotId?: string; latestSnapshotOnly?: boolean },
  signal?: AbortSignal,
): Promise<{ ok: boolean; apps: DeviceAppRaw[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    deviceId: filter?.deviceId,
    snapshotId: filter?.snapshotId,
    latestSnapshotOnly: filter?.latestSnapshotOnly,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/device-apps${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/device-apps failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchRawDeviceContacts(
  filter?: RawListFilter & { deviceId?: string; snapshotId?: string; latestSnapshotOnly?: boolean; search?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; contacts: DeviceContactRaw[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    deviceId: filter?.deviceId,
    snapshotId: filter?.snapshotId,
    latestSnapshotOnly: filter?.latestSnapshotOnly,
    search: filter?.search,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/device-contacts${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/device-contacts failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchRawDeviceHealth(
  filter?: RawListFilter & { deviceId?: string; observationType?: string; metric?: string; localDate?: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; observations: DeviceHealthRaw[]; total: number }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    deviceId: filter?.deviceId,
    observationType: filter?.observationType,
    metric: filter?.metric,
    localDate: filter?.localDate,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/device-health${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/device-health failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/**
 * Generic raw-table fetcher. Backed by the `/raw/<table>` HTTP dispatcher,
 * which whitelists table names server-side. The shape is identical for
 * every table — `rows` is an array of free-form snake_case records (the
 * raw row as stored in SQLite, including the `id`, `dedupe_key`, and
 * timing columns). UI is expected to dig out display fields from each
 * row generically rather than typing every toolkit individually here.
 */
export interface RawTableRow extends Record<string, unknown> {
  id: string;
  occurred_at?: string;
  ingested_at?: string;
}

export async function fetchRawTable(
  table: string,
  filter?: RawListFilter,
  signal?: AbortSignal,
): Promise<{ ok: boolean; rows: RawTableRow[]; total: number; table: string }> {
  const suffix = rawQuery({
    since: filter?.since,
    until: filter?.until,
    limit: filter?.limit,
  });
  const res = await proxyFetch(`/raw/${encodeURIComponent(table)}${suffix}`, { signal });
  if (!res.ok) throw new Error(`/raw/${table} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/**
 * SSE stream from the container proxy.
 * Returns an async iterator of parsed JSON events.
 */
export async function* proxySSE<T = unknown>(
  path: string,
  body: unknown,
  signal?: AbortSignal
): AsyncGenerator<T> {
  const res = await proxyPost(path, body, signal);
  if (!res.ok) throw new Error(`Proxy SSE ${path} failed: ${res.status}`);
  if (!res.body) throw new Error("No response body for SSE");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as T;
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Conversation Crystallize (debug panel) ──

export type TunableCrystallizeKey =
  | "messageThreshold"
  | "cooldownMs"
  | "salienceFloor"
  | "minUserChars";

export type TunableCrystallizeConfig = Partial<Record<TunableCrystallizeKey, number>>;

export type ChatSessionKind = "main" | "card" | "other";

export interface CrystallizeStateResponse {
  ok: boolean;
  state: {
    turn_count: number;
    last_crystallized_at: string | null;
    last_session_key: string | null;
    last_message_at: string | null;
  };
  settings: { auto_crystallize: boolean };
  config: {
    defaults: TunableCrystallizeConfig;
    override: TunableCrystallizeConfig;
    effective: TunableCrystallizeConfig;
    bounds: Record<TunableCrystallizeKey, { min: number; max: number; integer: boolean }>;
  };
  skillCounts: { active: number; disabled: number; total: number };
  recentDecisions: Array<{
    ts: string;
    decision: string;
    salience: number | null;
    summary: string;
    reason: string | null;
    memoryId: string | null;
    skillId: string | null;
    turnCount: number | null;
  }>;
  diagnostics: {
    lastSessionKey: string | null;
    lastSessionKind: ChatSessionKind | null;
    secondsSinceLastBump: number | null;
  };
}

export interface CrystallizeRunResponse {
  ok: boolean;
  result: {
    skipped: boolean;
    reason?: string;
    decision?: string;
    summary?: string;
    salience?: number;
    memoryId?: string;
    skillId?: string;
  };
}

export async function fetchCrystallizeState(signal?: AbortSignal): Promise<CrystallizeStateResponse> {
  const res = await proxyFetch("/crystallize/state", { signal });
  if (!res.ok) throw new Error(`/crystallize/state failed: ${res.status}`);
  return res.json();
}

export async function patchCrystallizeConfig(
  patch: Partial<Record<TunableCrystallizeKey, number | null>>,
): Promise<CrystallizeStateResponse> {
  const res = await proxyFetch("/crystallize/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/crystallize/config failed: ${res.status} ${detail}`);
  }
  return res.json();
}

export async function setAutoCrystallize(enabled: boolean): Promise<void> {
  const res = await proxyPost("/settings/auto-crystallize", { enabled });
  if (!res.ok) throw new Error(`/settings/auto-crystallize failed: ${res.status}`);
}

export async function forceCrystallizeRun(): Promise<CrystallizeRunResponse> {
  const res = await proxyPost("/crystallize/run", {});
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/crystallize/run failed: ${res.status} ${detail}`);
  }
  return res.json();
}

// ── v3 Skills (debug panel) ──────────────────────────────────────────────
//
// Response shape matches plugin `routes/skills.ts` which serves v3 `skill_index`
// rows plus the `SKILL.md` body on detail requests. See
// `docs/plans/memory-architecture.mdx` §三.

export type SkillStatus = "enabled" | "disabled" | "archived";

export interface Skill {
  id: string;
  title: string;
  description: string | null;
  status: SkillStatus;
  revision: number;
  body_hash: string;
  triggers: string[];
  source: string;
  created_run_id: string | null;
  last_updated_run_id: string | null;
  enabled_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
  /** Only populated on detail (GET /skills/:id) and after create/update. */
  body?: string;
}

export interface SkillCreateInput {
  title: string;
  body: string;
  description?: string | null;
  triggers?: string[];
  status?: "enabled" | "disabled";
}

export interface SkillPatch {
  title?: string;
  description?: string | null;
  body?: string;
  triggers?: string[];
  status?: SkillStatus;
}

export async function fetchSkills(
  params?: { status?: SkillStatus; limit?: number },
  signal?: AbortSignal,
): Promise<{ ok: boolean; skills: Skill[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/skills${suffix}`, { signal });
  if (!res.ok) throw new Error(`/skills failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchSkill(id: string, signal?: AbortSignal): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`/skills/${id} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function createSkill(input: SkillCreateInput): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyPost("/skills", input);
  if (!res.ok) throw new Error(`create skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function updateSkill(id: string, patch: SkillPatch): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/** Soft delete — backend flips status to 'archived'. */
export async function archiveSkill(id: string): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`archive skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── v3 Memory (debug panel) ──────────────────────────────────────────────
//
// Response shape matches plugin `routes/memory.ts` (v3 `MemoryRowV3`).
// DELETE is intentionally unavailable: use archive or supersede.

export type MemoryStatus = "active" | "archived" | "superseded";

export interface Memory {
  id: string;
  text: string;
  source: string;
  source_run_id: string | null;
  subject: string | null;
  quality: number;
  confidence: number;
  status: MemoryStatus;
  superseded_by: string | null;
  occurred_at: string | null;
  created_at: string;
  tags: string[];
  related_memory_ids: string[];
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface MemoryListFilter {
  status?: MemoryStatus;
  source?: string;
  subject?: string;
  subjectPrefix?: string;
  minQuality?: number;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  orderBy?: "created_at" | "quality" | "last_referenced_at";
  orderDirection?: "asc" | "desc";
}

export interface MemoryCreateInput {
  text: string;
  source: string;
  subject?: string | null;
  quality?: number;
  confidence?: number;
  tags?: string[];
  occurredAt?: string | null;
  sourceRunId?: string | null;
}

export interface MemoryPatch {
  text?: string;
  subject?: string | null;
  quality?: number;
  confidence?: number;
  tags?: string[];
}

export async function fetchMemories(
  filter?: MemoryListFilter,
  signal?: AbortSignal,
): Promise<{ ok: boolean; memories: Memory[]; total: number }> {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.source) qs.set("source", filter.source);
  if (filter?.subject) qs.set("subject", filter.subject);
  if (filter?.subjectPrefix) qs.set("subjectPrefix", filter.subjectPrefix);
  if (typeof filter?.minQuality === "number") qs.set("minQuality", String(filter.minQuality));
  if (filter?.since) qs.set("since", filter.since);
  if (filter?.until) qs.set("until", filter.until);
  if (filter?.limit) qs.set("limit", String(filter.limit));
  if (typeof filter?.offset === "number") qs.set("offset", String(filter.offset));
  if (filter?.orderBy) qs.set("orderBy", filter.orderBy);
  if (filter?.orderDirection) qs.set("orderDirection", filter.orderDirection);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/memory${suffix}`, { signal });
  if (!res.ok) throw new Error(`/memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchMemory(id: string, signal?: AbortSignal): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyFetch(`/memory/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`/memory/${id} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function createMemory(input: MemoryCreateInput): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyPost("/memory", input);
  if (!res.ok) throw new Error(`create memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function updateMemory(id: string, patch: MemoryPatch): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyFetch(`/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/** Soft delete — backend flips status to 'archived'. */
export async function archiveMemory(id: string): Promise<void> {
  const res = await proxyPost(`/memory/${encodeURIComponent(id)}/archive`, {});
  if (!res.ok) throw new Error(`archive memory failed: ${await readErrorMessage(res)}`);
}

export async function supersedeMemory(oldId: string, newId: string): Promise<void> {
  const res = await proxyPost("/memory/supersede", { oldId, newId });
  if (!res.ok) throw new Error(`supersede memory failed: ${await readErrorMessage(res)}`);
}
