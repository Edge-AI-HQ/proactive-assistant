/**
 * Unified device intake. All devices (phone / wearable / sensor / etc.)
 * push items here. Each item lands in `personal_signals` (proactive.db);
 * snapshot itemTypes additionally fan out to `raw.db.device_*_snapshot`;
 * itemTypes carrying base64 binary (ambient.image_chunk / ambient.audio_chunk)
 * have their bytes written to the FS under
 * `<OPENCLAW_HOME>/data/media/<deviceId>/<YYYY-MM-DD>/<id>.<ext>` and
 * the resulting file_path is stored on the signal payload.
 *
 * See docs/plans/2026-04-28-device-ingest-unification.mdx for the design,
 * and docs/plans/memory-architecture.mdx §一 / §四 for the two-tier signal
 * + raw model that this builds on.
 */
import fs from "node:fs";
import path from "node:path";
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

export interface DeviceItemInput {
  id: string;
  /**
   * The item kind. Same field as personal_signals.kind. We accept the
   * legacy alias `itemType` from older mobile clients (extracted at the
   * HTTP boundary).
   */
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

export interface DeviceIngestResult {
  accepted: number;
  inserted: number;
  ignored: number;
}

/**
 * Map an item kind that carries binary in `payload.binary_b64` to a file
 * extension. Returns null for non-binary kinds so we skip the FS write.
 *
 * Keep this list small — adding a new kind here is the entire delta
 * required to support a new media type.
 */
function mediaExtForKind(kind: string, mime?: string): string | null {
  switch (kind) {
    case "ambient.image_chunk":
      return "jpg";
    case "ambient.audio_chunk":
      return "opus";
    case "ambient.video_chunk":
      return "mp4";
    default:
      // Generic binary item: trust mime, fallback to .bin
      if (kind.startsWith("device.media.") && typeof mime === "string") {
        const slash = mime.lastIndexOf("/");
        return slash >= 0 ? mime.slice(slash + 1).split(";")[0]!.trim() || "bin" : "bin";
      }
      return null;
  }
}

function dateDir(iso: string): string {
  // YYYY-MM-DD
  return iso.slice(0, 10);
}

/**
 * Persist base64 binary on payload.binary_b64 to disk.
 * Returns the relative file_path (under media/) that should be put back
 * onto the signal payload, or null if there is no binary to persist.
 */
function persistBinary(
  deviceId: string,
  item: DeviceItemInput,
  occurredAt: string,
): { filePath: string; byteLen: number } | null {
  const payload = item.payload ?? {};
  const b64 = typeof payload.binary_b64 === "string" ? payload.binary_b64 : null;
  if (!b64) return null;

  const mime = typeof payload.mime === "string" ? payload.mime : undefined;
  const ext = mediaExtForKind(item.itemType, mime);
  if (!ext) return null;

  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) return null;

  const home = process.env.OPENCLAW_HOME || "/app";
  const dir = path.join(home, "data", "media", deviceId, dateDir(occurredAt));
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${item.id}.${ext}`;
  const fullPath = path.join(dir, fileName);
  fs.writeFileSync(fullPath, buf);

  // We store the path relative to <home>/data/media for portability across
  // container moves. Readers prepend OPENCLAW_HOME at access time.
  const relPath = path.join("media", deviceId, dateDir(occurredAt), fileName);
  return { filePath: relPath, byteLen: buf.length };
}

/**
 * Core write path. Shared between the HTTP handler and test code.
 * Writes every item to `personal_signals` (dedupe_key enforced) and
 * additionally fans snapshot-type payloads out to raw.db.
 *
 * For media items (kind ∈ {ambient.image_chunk, ambient.audio_chunk, ...}),
 * the base64 bytes on payload.binary_b64 are written to the FS and the
 * payload stored on the signal references file_path / byte_len instead.
 */
export async function ingestDeviceItems(
  deviceId: string,
  items: DeviceItemInput[],
): Promise<DeviceIngestResult> {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0 };
  const createdAt = nowIso();

  const signals = items.map((item) => {
    const occurredAt = normalizeIso(item.occurredAt, createdAt);
    const availableAt = normalizeIso(item.availableAt, occurredAt);
    const expiresAt = normalizeExpiresAt(occurredAt, item.expiresAt);

    let payload: Record<string, unknown> = item.payload ?? {};
    try {
      const persisted = persistBinary(deviceId, item, occurredAt);
      if (persisted) {
        // Replace base64 with a path reference. Keep all metadata
        // (width / height / duration_ms / sample_rate / codec_id / mime).
        const { binary_b64: _drop, ...rest } = payload;
        void _drop;
        payload = {
          ...rest,
          file_path: persisted.filePath,
          byte_len: persisted.byteLen,
        };
      }
    } catch (err) {
      console.warn(`[device ingest] persistBinary failed for ${item.itemType}: ${err instanceof Error ? err.message : err}`);
    }

    return {
      id: item.id,
      kind: item.itemType,
      title: item.title,
      summary: item.summary,
      payload,
      salience: item.salience ?? 0,
      confidence: item.confidence ?? 0,
      dedupeKey: item.dedupeKey?.trim() || `device:${deviceId}:${item.id}`,
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
      console.warn(`[device ingest] raw bridge for ${item.itemType} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    accepted: items.length,
    inserted: result.inserted ?? 0,
    ignored: (items.length - (result.inserted ?? 0)),
  };
}

export function handleDevices(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath === "/devices/ingest" && ctx.req.method === "POST") {
      const body = await readBody(ctx.req);
      const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
      const itemsRaw = Array.isArray(body.items) ? body.items : [];
      if (!deviceId) {
        json(ctx.res, 400, { ok: false, error: "deviceId is required" });
        return true;
      }
      const items: DeviceItemInput[] = itemsRaw.map((item) => ({
        id: typeof item?.id === "string" ? item.id : "",
        // Accept both `kind` (preferred) and `itemType` (legacy alias).
        itemType: typeof item?.kind === "string" ? item.kind
          : typeof item?.itemType === "string" ? item.itemType : "",
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
      const result = await ingestDeviceItems(deviceId, items);
      json(ctx.res, 200, { ok: true, ...result });
      return true;
    }

    // GET /devices/media/<rel-path> — serve a previously persisted binary
    // for timeline / chat preview. The relative path must start with
    // "media/" (the prefix returned in payload.file_path); anything else
    // gets a 400 to keep callers from probing the FS.
    if (ctx.subpath.startsWith("/devices/media/") && ctx.req.method === "GET") {
      const rel = ctx.subpath.slice("/devices/media/".length);
      if (!rel || rel.includes("..") || !rel.startsWith("media/")) {
        json(ctx.res, 400, { ok: false, error: "invalid_path" });
        return true;
      }
      const home = process.env.OPENCLAW_HOME || "/app";
      const fullPath = path.join(home, "data", rel);
      if (!fs.existsSync(fullPath)) {
        json(ctx.res, 404, { ok: false, error: "not_found" });
        return true;
      }
      const ext = path.extname(rel).toLowerCase();
      const mime =
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
          : ext === ".png" ? "image/png"
            : ext === ".gif" ? "image/gif"
              : ext === ".webp" ? "image/webp"
                : ext === ".mp4" ? "video/mp4"
                  : ext === ".mov" ? "video/quicktime"
                    : ext === ".webm" ? "video/webm"
                      : ext === ".opus" ? "audio/opus"
                        : ext === ".ogg" ? "audio/ogg"
                          : ext === ".mp3" ? "audio/mpeg"
                            : ext === ".wav" ? "audio/wav"
                              : "application/octet-stream";
      const buf = fs.readFileSync(fullPath);
      ctx.res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=3600",
      });
      ctx.res.end(buf);
      return true;
    }

    return false;
  };
}
