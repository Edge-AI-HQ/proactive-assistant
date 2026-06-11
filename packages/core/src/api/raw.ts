import { readErrorMessage } from "../transport/errors";
import { proxyFetch } from "../transport/http";

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
