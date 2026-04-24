/**
 * Device-side mobile item intake. v3: writes land directly in
 * `personal_signals` (proactive.db) with snapshot itemTypes additionally
 * fanning out to `raw.db.device_*_snapshot`. The legacy `mobile_items.db`
 * store and its claim/commit run-token flow have been removed — pre-product
 * cutover, no consumers.
 *
 * See docs/plans/memory-architecture.mdx §一 / §四 for the two-tier design.
 */
import * as v3Db from "../db.js";
import * as rawDb from "../raw-db.js";
import type { RouteHandler } from "./types.js";
import { json, readBody } from "./types.js";

const DEFAULT_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIso(value: string | number | undefined, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function normalizeExpiresAt(occurredAt: string, expiresAt?: string | number): string {
  if (typeof expiresAt === "number" || (typeof expiresAt === "string" && expiresAt.trim())) {
    return normalizeIso(expiresAt, new Date(Date.parse(occurredAt) + DEFAULT_ITEM_TTL_MS).toISOString());
  }
  return new Date(Date.parse(occurredAt) + DEFAULT_ITEM_TTL_MS).toISOString();
}

interface MobileItemInput {
  id: string;
  itemType: string;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  salience?: number;
  confidence?: number;
  dedupeKey?: string;
  occurredAt?: string | number;
  availableAt?: string | number;
  expiresAt?: string | number;
}

/**
 * Pull the app list out of a snapshot payload. The on-device
 * ItemDerivationEngine packs things under different keys depending on
 * bootstrap vs incremental, so we try the common shapes.
 */
function extractAppsFromPayload(payload: Record<string, unknown>): Array<{
  bundleId: string; appName: string; version?: string | null; lastUsedAt?: string | null;
}> {
  const candidates: unknown[] = [];
  if (Array.isArray(payload.apps)) candidates.push(...payload.apps);
  if (Array.isArray(payload.installedApps)) candidates.push(...payload.installedApps);
  if (Array.isArray(payload.items)) candidates.push(...payload.items);
  if (Array.isArray(payload.entries)) candidates.push(...payload.entries);
  return candidates
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
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
    .filter((a) => a.bundleId && a.appName);
}

function extractContactsFromPayload(payload: Record<string, unknown>): Array<{
  displayName?: string | null; emails?: string[]; phones?: string[]; lastModified?: string | null;
}> {
  const candidates: unknown[] = [];
  if (Array.isArray(payload.contacts)) candidates.push(...payload.contacts);
  if (Array.isArray(payload.items)) candidates.push(...payload.items);
  if (Array.isArray(payload.entries)) candidates.push(...payload.entries);
  return candidates
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((row) => {
      const emails = Array.isArray(row.emails) ? row.emails.filter((e): e is string => typeof e === "string")
        : typeof row.email === "string" ? [row.email] : [];
      const phones = Array.isArray(row.phones) ? row.phones.filter((p): p is string => typeof p === "string")
        : Array.isArray(row.phoneNumbers) ? row.phoneNumbers.filter((p): p is string => typeof p === "string")
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

export interface MobileIngestResult {
  accepted: number;
  inserted: number;
  ignored: number;
}

/**
 * Core write path. Shared between the HTTP handler and test code.
 * Writes every item to `personal_signals` (dedupe_key enforced) and
 * additionally fans snapshot-type payloads out to raw.db.
 */
export async function ingestMobileItemsV3(
  deviceId: string,
  items: MobileItemInput[],
): Promise<MobileIngestResult> {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0 };
  const createdAt = nowIso();

  const signals = items.map((item) => {
    const occurredAt = normalizeIso(item.occurredAt, createdAt);
    const availableAt = normalizeIso(item.availableAt, occurredAt);
    const expiresAt = normalizeExpiresAt(occurredAt, item.expiresAt);
    return {
      id: item.id,
      kind: item.itemType,
      title: item.title,
      summary: item.summary,
      payload: item.payload ?? {},
      salience: item.salience ?? 0,
      confidence: item.confidence ?? 0,
      dedupeKey: item.dedupeKey?.trim() || `mobile:${deviceId}:${item.id}`,
      occurredAt,
      availableAt,
      expiresAt,
      source: "device",
      deviceId,
    };
  });

  const result = await v3Db.ingestPersonalSignals(signals);

  // Fan out snapshot-type payloads to raw.db so evolution agents can query
  // them tabularly ("top 20 apps", "search contact by name"). Failures here
  // are logged but must not fail the overall ingest — personal_signals is
  // the source of truth for "we got the upload".
  for (const item of items) {
    try {
      if (item.itemType === "app_inventory_bootstrap" || item.itemType === "app_inventory_snapshot") {
        const apps = extractAppsFromPayload(item.payload ?? {});
        if (apps.length > 0) {
          rawDb.ingestDeviceAppsSnapshot({
            deviceId,
            capturedAt: normalizeIso(item.occurredAt, createdAt),
            apps,
          });
        }
      } else if (item.itemType === "contact_directory_snapshot" || item.itemType === "contact_bootstrap") {
        const contacts = extractContactsFromPayload(item.payload ?? {});
        if (contacts.length > 0) {
          rawDb.ingestDeviceContactsSnapshot({
            deviceId,
            capturedAt: normalizeIso(item.occurredAt, createdAt),
            contacts,
          });
        }
      }
    } catch (err) {
      console.warn(`[mobile ingest] raw bridge for ${item.itemType} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    accepted: items.length,
    inserted: result.inserted ?? 0,
    ignored: (items.length - (result.inserted ?? 0)),
  };
}

export function handleMobile(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath === "/mobile/items/ingest" && ctx.req.method === "POST") {
      const body = await readBody(ctx.req);
      const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
      const itemsRaw = Array.isArray(body.items) ? body.items : [];
      if (!deviceId) {
        json(ctx.res, 400, { ok: false, error: "deviceId is required" });
        return true;
      }
      const items: MobileItemInput[] = itemsRaw.map((item) => ({
        id: typeof item?.id === "string" ? item.id : "",
        itemType: typeof item?.itemType === "string" ? item.itemType : "",
        title: typeof item?.title === "string" ? item.title : "",
        summary: typeof item?.summary === "string" ? item.summary : "",
        payload: typeof item?.payload === "object" && item.payload !== null ? item.payload as Record<string, unknown> : {},
        salience: typeof item?.salience === "number" ? item.salience : 0,
        confidence: typeof item?.confidence === "number" ? item.confidence : 0,
        dedupeKey: typeof item?.dedupeKey === "string" ? item.dedupeKey : undefined,
        occurredAt: typeof item?.occurredAt === "string" || typeof item?.occurredAt === "number" ? item.occurredAt : undefined,
        availableAt: typeof item?.availableAt === "string" || typeof item?.availableAt === "number" ? item.availableAt : undefined,
        expiresAt: typeof item?.expiresAt === "string" || typeof item?.expiresAt === "number" ? item.expiresAt : undefined,
      })).filter((item) => item.id && item.itemType && item.title && item.summary);
      const result = await ingestMobileItemsV3(deviceId, items);
      json(ctx.res, 200, { ok: true, ...result });
      return true;
    }

    // Legacy endpoints removed in the v3 mobile cutover. Return a clear
    // 410 so any stray caller surfaces a migration error rather than 404.
    if (
      (ctx.subpath === "/mobile/items" && ctx.req.method === "GET") ||
      (ctx.subpath === "/mobile/items/claim" && ctx.req.method === "POST") ||
      (ctx.subpath === "/mobile/items/commit" && ctx.req.method === "POST")
    ) {
      json(ctx.res, 410, {
        ok: false,
        error: "endpoint removed",
        hint: "Mobile items live in personal_signals now. Query via `pin signals list` / `pin signals recent`; consume via `pin signals consume --id <id> --runId <run>`.",
      });
      return true;
    }

    return false;
  };
}
