import type * as db from "../db.js";
import type * as raw from "../raw-db.js";
import { healthFullReplaceScope, parseHealthObservations } from "./health.js";

export type DeviceIngestMode = "raw_only" | "signal_only" | "dual";
export type DeviceSyncMode = "incremental" | "full";

export interface DeviceIngestItem {
  id: string;
  deviceId: string;
  kind: string;
  syncMode: DeviceSyncMode;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  salience: number;
  confidence: number;
  dedupeKey: string;
  occurredAt: string;
  availableAt: string;
  expiresAt: string | null;
}

export type DeviceRawWrite =
  | { table: "device_apps_snapshot"; input: raw.IngestDeviceAppsInput }
  | { table: "device_contacts_snapshot"; input: raw.IngestDeviceContactsInput }
  | { table: "device_health_observations"; input: raw.IngestDeviceHealthInput };

export type DeviceRawReplaceScope =
  | { table: "device_apps_snapshot"; deviceId: string }
  | { table: "device_contacts_snapshot"; deviceId: string }
  | ({ table: "device_health_observations" } & raw.DeviceHealthReplaceScope);

export interface DeviceIngestPolicy {
  mode: DeviceIngestMode;
  rawTable?: DeviceRawWrite["table"];
  parseRaw?: (item: DeviceIngestItem) => DeviceRawWrite[];
  fullReplaceScope?: (item: DeviceIngestItem) => DeviceRawReplaceScope | null;
  buildSignal?: (
    item: DeviceIngestItem,
    opts?: { fallbackReason?: string },
  ) => db.IngestPersonalSignalInput | null;
}

export function normalizeDeviceSyncMode(rawValue: unknown): DeviceSyncMode {
  return rawValue === "full" ? "full" : "incremental";
}

function extractAppsFromPayload(payload: Record<string, unknown>): raw.DeviceAppSnapshotItem[] {
  const candidates: unknown[] = [];
  if (Array.isArray(payload.apps)) candidates.push(...payload.apps);
  if (Array.isArray(payload.installedApps)) candidates.push(...payload.installedApps);
  if (Array.isArray(payload.items)) candidates.push(...payload.items);
  if (Array.isArray(payload.entries)) candidates.push(...payload.entries);
  return candidates
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    .map((row) => ({
      bundleId: typeof row.bundleId === "string" ? row.bundleId
        : typeof row.bundle_id === "string" ? row.bundle_id
          : typeof row.packageName === "string" ? row.packageName : "",
      appName: typeof row.appName === "string" ? row.appName
        : typeof row.app_name === "string" ? row.app_name
          : typeof row.name === "string" ? row.name : "",
      version: typeof row.version === "string" ? row.version : null,
      lastUsedAt: typeof row.lastUsedAt === "string" ? row.lastUsedAt
        : typeof row.last_used_at === "string" ? row.last_used_at : null,
    }))
    .filter((app) => app.bundleId && app.appName);
}

function extractContactsFromPayload(payload: Record<string, unknown>): raw.DeviceContactSnapshotItem[] {
  const candidates: unknown[] = [];
  if (Array.isArray(payload.contacts)) candidates.push(...payload.contacts);
  if (Array.isArray(payload.items)) candidates.push(...payload.items);
  if (Array.isArray(payload.entries)) candidates.push(...payload.entries);
  return candidates
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    .map((row) => {
      const emails = Array.isArray(row.emails)
        ? row.emails.filter((e): e is string => typeof e === "string")
        : typeof row.email === "string" ? [row.email] : [];
      const phones = Array.isArray(row.phones)
        ? row.phones.filter((p): p is string => typeof p === "string")
        : Array.isArray(row.phoneNumbers)
          ? row.phoneNumbers.filter((p): p is string => typeof p === "string")
          : typeof row.phone === "string" ? [row.phone] : [];
      return {
        displayName: typeof row.displayName === "string" ? row.displayName
          : typeof row.display_name === "string" ? row.display_name
            : typeof row.name === "string" ? row.name : null,
        emails,
        phones,
        lastModified: typeof row.lastModified === "string" ? row.lastModified
          : typeof row.last_modified === "string" ? row.last_modified : null,
      };
    });
}

function parseDeviceAppsSnapshot(item: DeviceIngestItem): DeviceRawWrite[] {
  const apps = extractAppsFromPayload(item.payload);
  if (apps.length === 0) return [];
  return [{
    table: "device_apps_snapshot",
    input: {
      deviceId: item.deviceId,
      capturedAt: item.occurredAt,
      snapshotId: item.dedupeKey,
      apps,
    },
  }];
}

function parseDeviceContactsSnapshot(item: DeviceIngestItem): DeviceRawWrite[] {
  const contacts = extractContactsFromPayload(item.payload);
  if (contacts.length === 0) return [];
  return [{
    table: "device_contacts_snapshot",
    input: {
      deviceId: item.deviceId,
      capturedAt: item.occurredAt,
      snapshotId: item.dedupeKey,
      contacts,
    },
  }];
}

function parseHealthRaw(item: DeviceIngestItem): DeviceRawWrite[] {
  const observations = parseHealthObservations(item);
  if (observations.length === 0) return [];
  return [{
    table: "device_health_observations",
    input: {
      deviceId: item.deviceId,
      observations,
    },
  }];
}

export function buildDefaultDeviceSignal(
  item: DeviceIngestItem,
  opts: { fallbackReason?: string } = {},
): db.IngestPersonalSignalInput {
  const payload = opts.fallbackReason
    ? { ...item.payload, ingest_fallback_reason: opts.fallbackReason }
    : item.payload;
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    payload,
    salience: item.salience,
    confidence: item.confidence,
    dedupeKey: item.dedupeKey,
    occurredAt: item.occurredAt,
    availableAt: item.availableAt,
    expiresAt: item.expiresAt,
    source: "device",
    deviceId: item.deviceId,
  };
}

const APP_INVENTORY_POLICY: DeviceIngestPolicy = {
  mode: "dual",
  rawTable: "device_apps_snapshot",
  parseRaw: parseDeviceAppsSnapshot,
  fullReplaceScope: (item) => ({ table: "device_apps_snapshot", deviceId: item.deviceId }),
  buildSignal: buildDefaultDeviceSignal,
};

const CONTACT_DIRECTORY_POLICY: DeviceIngestPolicy = {
  mode: "dual",
  rawTable: "device_contacts_snapshot",
  parseRaw: parseDeviceContactsSnapshot,
  fullReplaceScope: (item) => ({ table: "device_contacts_snapshot", deviceId: item.deviceId }),
  buildSignal: buildDefaultDeviceSignal,
};

const HEALTH_OBSERVATION_POLICY: DeviceIngestPolicy = {
  mode: "raw_only",
  rawTable: "device_health_observations",
  parseRaw: parseHealthRaw,
  fullReplaceScope: (item) => {
    const scope = healthFullReplaceScope(item);
    return scope ? { table: "device_health_observations", ...scope } : null;
  },
};

const SIGNAL_ONLY_POLICY: DeviceIngestPolicy = {
  mode: "signal_only",
  buildSignal: buildDefaultDeviceSignal,
};

export const DEVICE_INGEST_POLICIES: Record<string, DeviceIngestPolicy> = {
  session_summary: SIGNAL_ONLY_POLICY,
  moment: SIGNAL_ONLY_POLICY,
  attention_item: SIGNAL_ONLY_POLICY,
  "ambient.image_chunk": SIGNAL_ONLY_POLICY,
  "ambient.audio_chunk": SIGNAL_ONLY_POLICY,
  "ambient.video_chunk": SIGNAL_ONLY_POLICY,
  app_inventory: APP_INVENTORY_POLICY,
  app_inventory_bootstrap: APP_INVENTORY_POLICY,
  app_inventory_snapshot: APP_INVENTORY_POLICY,
  contact_directory: CONTACT_DIRECTORY_POLICY,
  contact_bootstrap: CONTACT_DIRECTORY_POLICY,
  contact_directory_snapshot: CONTACT_DIRECTORY_POLICY,
  "health.observation": HEALTH_OBSERVATION_POLICY,
};

export const UNKNOWN_KIND_POLICY: DeviceIngestPolicy = {
  mode: "signal_only",
  buildSignal: (item) => buildDefaultDeviceSignal(item, { fallbackReason: "unknown_kind" }),
};

export function resolveDeviceIngestPolicy(kind: string): DeviceIngestPolicy {
  if (kind.startsWith("device.media.")) return SIGNAL_ONLY_POLICY;
  return DEVICE_INGEST_POLICIES[kind] ?? UNKNOWN_KIND_POLICY;
}
