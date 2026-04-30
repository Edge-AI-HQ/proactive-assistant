/**
 * Unified device intake. All devices (phone / wearable / sensor / etc.)
 * push items here. Cloud-side kind policies decide whether an item lands in
 * `personal_signals`, a typed `raw.db` table, or both. Unknown kinds fall
 * back to `personal_signals` so uploads are not dropped.
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
import {
  buildDefaultDeviceSignal,
  normalizeDeviceSyncMode,
  resolveDeviceIngestPolicy,
  type DeviceIngestItem,
  type DeviceRawReplaceScope,
  type DeviceRawWrite,
  type DeviceSyncMode,
} from "../device-ingest/policies.js";
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
  syncMode?: DeviceSyncMode;
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

export interface DeviceIngestResult {
  accepted: number;
  inserted: number;
  ignored: number;
  results: DeviceIngestItemResult[];
}

export interface DeviceIngestItemResult {
  id: string;
  dedupe_key?: string;
  status: "inserted" | "duplicate";
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

function writeRaw(
  write: DeviceRawWrite,
  syncMode: DeviceSyncMode,
  scope: DeviceRawReplaceScope | null,
): rawDb.IngestResult {
  if (write.table === "device_apps_snapshot") {
    return syncMode === "full"
      ? rawDb.replaceDeviceAppsSnapshot(write.input)
      : rawDb.ingestDeviceAppsSnapshot(write.input);
  }
  if (write.table === "device_contacts_snapshot") {
    return syncMode === "full"
      ? rawDb.replaceDeviceContactsSnapshot(write.input)
      : rawDb.ingestDeviceContactsSnapshot(write.input);
  }
  if (write.table === "device_health_observations") {
    if (syncMode === "full") {
      if (!scope || scope.table !== "device_health_observations") {
        return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
      }
      return rawDb.replaceDeviceHealthObservations(scope, write.input);
    }
    return rawDb.ingestDeviceHealthObservations(write.input);
  }
  return { accepted: 0, inserted: 0, ignored: 0, ids: [] };
}

/**
 * Core write path. Shared between the HTTP handler and test code.
 * Applies the device ingest policy registry. Most event-like kinds write to
 * `personal_signals`; registered raw kinds write to typed raw tables; `dual`
 * policies do both.
 *
 * For media items (kind ∈ {ambient.image_chunk, ambient.audio_chunk, ...}),
 * the base64 bytes on payload.binary_b64 are written to the FS and the
 * payload stored on the signal references file_path / byte_len instead.
 */
export async function ingestDeviceItems(
  deviceId: string,
  items: DeviceItemInput[],
): Promise<DeviceIngestResult> {
  if (items.length === 0) return { accepted: 0, inserted: 0, ignored: 0, results: [] };
  const createdAt = nowIso();

  const normalizedItems: DeviceIngestItem[] = items.map((item) => {
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
      deviceId,
      kind: item.itemType,
      syncMode: item.syncMode ?? "incremental",
      title: item.title,
      summary: item.summary,
      payload,
      salience: item.salience ?? 0,
      confidence: item.confidence ?? 0,
      dedupeKey: item.dedupeKey?.trim() || `device:${deviceId}:${item.id}`,
      occurredAt,
      availableAt,
      expiresAt,
    };
  });

  const signalWrites: Array<{ itemId: string; input: v3Db.IngestPersonalSignalInput }> = [];
  const rawInsertedByItem = new Map<string, boolean>();

  for (const item of normalizedItems) {
    const policy = resolveDeviceIngestPolicy(item.kind);
    let rawSucceeded = false;
    let rawFailed = false;

    try {
      if (policy.mode === "raw_only" || policy.mode === "dual") {
        const rawWrites = policy.parseRaw?.(item) ?? [];
        if (rawWrites.length === 0) {
          const fallback = buildDefaultDeviceSignal(item, { fallbackReason: "raw_parse_failed" });
          signalWrites.push({ itemId: item.id, input: fallback });
          continue;
        }
        const scope = item.syncMode === "full" ? policy.fullReplaceScope?.(item) ?? null : null;
        if (item.syncMode === "full" && !scope) {
          const fallback = buildDefaultDeviceSignal(item, { fallbackReason: "unsupported_full_sync" });
          signalWrites.push({ itemId: item.id, input: fallback });
          continue;
        }
        for (const write of rawWrites) {
          const rawResult = writeRaw(write, item.syncMode, scope);
          rawSucceeded = rawSucceeded || rawResult.inserted > 0;
        }
      }
    } catch (err) {
      rawFailed = true;
      console.warn(`[device ingest] raw policy for ${item.kind} failed: ${err instanceof Error ? err.message : err}`);
    }

    rawInsertedByItem.set(item.id, rawSucceeded);

    if (rawFailed && policy.mode === "raw_only") {
      signalWrites.push({
        itemId: item.id,
        input: buildDefaultDeviceSignal(item, { fallbackReason: "raw_write_failed" }),
      });
      continue;
    }

    if (policy.mode === "signal_only" || policy.mode === "dual") {
      const signal = policy.buildSignal?.(item) ?? buildDefaultDeviceSignal(item);
      if (signal) signalWrites.push({ itemId: item.id, input: signal });
    }
  }

  const signalInputs = signalWrites.map((write) => write.input);
  const signalResult = await v3Db.ingestPersonalSignals(signalInputs);
  const insertedSignalIds = new Set(signalResult.ids);
  const signalInsertedByItem = new Map<string, boolean>();
  for (const write of signalWrites) {
    signalInsertedByItem.set(
      write.itemId,
      (signalInsertedByItem.get(write.itemId) ?? false) || insertedSignalIds.has(write.input.id ?? ""),
    );
  }

  const itemResults: DeviceIngestItemResult[] = normalizedItems.map((item) => {
    const inserted = (rawInsertedByItem.get(item.id) ?? false) || (signalInsertedByItem.get(item.id) ?? false);
    return {
      id: item.id,
      dedupe_key: item.dedupeKey,
      status: inserted ? "inserted" : "duplicate",
    };
  });
  const inserted = itemResults.filter((item) => item.status === "inserted").length;

  return {
    accepted: items.length,
    inserted,
    ignored: items.length - inserted,
    results: itemResults,
  };
}

/**
 * Pluck a string field that may live under several legacy aliases.
 * Returns the first non-empty hit or `undefined`.
 */
function strField(item: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function strOrNumField(item: Record<string, unknown>, ...keys: string[]): string | number | undefined {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Parse a `source: "<scheme>:<id>"` string. scheme is one of
 *   device | mobile | connector | web
 * Returns null when malformed; caller falls back to header / explicit deviceId.
 */
function parseSource(raw: unknown): { scheme: string; id: string } | null {
  if (typeof raw !== "string") return null;
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) return null;
  const scheme = raw.slice(0, idx);
  if (!["device", "mobile", "connector", "web"].includes(scheme)) return null;
  return { scheme, id: raw.slice(idx + 1) };
}

export function handleDevices(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath === "/devices/ingest" && ctx.req.method === "POST") {
      const body = await readBody(ctx.req);

      // PersonalSignal envelope accepts two body shapes:
      //   - PREFERRED: top-level array of signals, each carries
      //       `source: "device:<id>"` (scheme picks routing, id is the
      //       device_id this row belongs to).
      //   - LEGACY:   { deviceId, items: [...] } — current callers / smoke
      //       script. deviceId from the wrapper is used as fallback when a
      //       signal doesn't carry its own `source`.
      const isArrayBody = Array.isArray(body);
      const wrapperDeviceId = !isArrayBody && typeof body.deviceId === "string"
        ? body.deviceId.trim() : "";
      const itemsRaw = isArrayBody
        ? body
        : Array.isArray(body.items) ? body.items : [];

      // Group items by deviceId so a single batch can fan out to multiple
      // devices when callers use envelope `source` (a phone bridging
      // multiple BLE sub-devices, for example).
      const byDevice = new Map<string, DeviceItemInput[]>();
      for (const raw of itemsRaw) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const sourceParsed = parseSource(item.source);
        const deviceId = sourceParsed?.id ?? wrapperDeviceId;
        if (!deviceId) continue;
        const id = strField(item, "id") ?? "";
        // Accept `kind` (preferred) and `itemType` (legacy alias).
        const itemType = strField(item, "kind", "itemType") ?? "";
        const title = strField(item, "title") ?? "";
        const summary = strField(item, "summary") ?? "";
        if (!id || !itemType || !title || !summary) continue;
        const occurredAt = strOrNumField(item, "occurred_at", "occurredAt");
        const availableAt = strOrNumField(item, "available_at", "availableAt");
        const expiresAt = strOrNumField(item, "expires_at", "expiresAt");
        const dedupeKey = strField(item, "dedupe_key", "dedupeKey");
        const syncRaw = item.sync_mode ?? item.syncMode;
        const syncMode = normalizeDeviceSyncMode(syncRaw);
        if (syncRaw !== undefined && syncRaw !== "incremental" && syncRaw !== "full") {
          console.warn(`[device ingest] invalid sync_mode for ${itemType}: ${String(syncRaw)}; defaulting to incremental`);
        }
        const payload = typeof item.payload === "object" && item.payload !== null
          ? item.payload as Record<string, unknown> : {};
        const list = byDevice.get(deviceId) ?? [];
        list.push({
          id, itemType, syncMode, title, summary, payload,
          salience: typeof item.salience === "number" ? item.salience : 0,
          confidence: typeof item.confidence === "number" ? item.confidence : 0,
          dedupeKey,
          occurredAt,
          availableAt,
          expiresAt,
        });
        byDevice.set(deviceId, list);
      }

      if (byDevice.size === 0) {
        // No usable items + no fallback deviceId means the request is
        // malformed regardless of which body shape was used.
        if (!wrapperDeviceId) {
          json(ctx.res, 400, { ok: false, error: "deviceId or signal `source` required" });
          return true;
        }
      }

      let accepted = 0, inserted = 0, ignored = 0;
      const results: DeviceIngestItemResult[] = [];
      for (const [deviceId, items] of byDevice) {
        const r = await ingestDeviceItems(deviceId, items);
        accepted += r.accepted;
        inserted += r.inserted;
        ignored += r.ignored;
        results.push(...r.results);
      }
      json(ctx.res, 200, { ok: true, accepted, inserted, ignored, results });
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
