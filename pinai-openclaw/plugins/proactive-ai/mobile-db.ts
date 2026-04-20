import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type BetterSqliteModule = typeof import("better-sqlite3");

const require = createRequire(import.meta.url);

function loadBetterSqlite3(): BetterSqliteModule["default"] {
  const candidates = [
    "better-sqlite3",
    path.join(process.cwd(), "proactive-ai/node_modules/better-sqlite3"),
  ];
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate) as BetterSqliteModule;
      return (loaded as BetterSqliteModule & { default?: BetterSqliteModule["default"] }).default ?? (loaded as unknown as BetterSqliteModule["default"]);
    } catch {
      // Try next candidate.
    }
  }
  throw new Error("better-sqlite3 is not available");
}

const Database = loadBetterSqlite3();

let mobileDb: Database.Database | null = null;

const MOBILE_USER_ID = "local";
const DEFAULT_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RUN_TTL_MS = 15 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function resolveMobileDb(): Database.Database {
  if (mobileDb) return mobileDb;
  const home = process.env.OPENCLAW_HOME || "/app";
  const dir = path.join(home, "data");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "mobile_items.db");
  mobileDb = new Database(dbPath);
  mobileDb.pragma("journal_mode = WAL");
  mobileDb.pragma("busy_timeout = 5000");
  ensureSchema(mobileDb);
  return mobileDb;
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      salience REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      dedupe_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'processed', 'expired')),
      occurred_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      expires_at TEXT,
      processed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_items_dedupe ON mobile_items(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mobile_items_status_available
      ON mobile_items(status, available_at, occurred_at);

    CREATE TABLE IF NOT EXISTS mobile_ingest_batches (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      accepted_count INTEGER NOT NULL,
      inserted_count INTEGER NOT NULL,
      ignored_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mobile_item_runs (
      run_token TEXT PRIMARY KEY,
      item_ids_json TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'committed', 'expired')),
      committed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_item_runs_status_created
      ON mobile_item_runs(status, created_at);
  `);
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export interface MobileItemInput {
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

export interface MobileIngestPayload {
  deviceId: string;
  items: MobileItemInput[];
}

export interface MobileItemRecord {
  id: string;
  userId: string;
  deviceId: string;
  itemType: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  salience: number;
  confidence: number;
  dedupeKey: string | null;
  status: "pending" | "claimed" | "processed" | "expired";
  occurredAt: string;
  availableAt: string;
  expiresAt: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface ListMobileItemsFilters {
  status?: string;
  itemType?: string;
  since?: string;
  until?: string;
  deviceId?: string;
  order?: string;
  limit?: number;
}

export interface MobileClaimResult {
  runToken: string | null;
  items: MobileItemRecord[];
}

function normalizeOrder(order?: string): "ASC" | "DESC" {
  return order?.trim().toLowerCase() === "desc" ? "DESC" : "ASC";
}

function mapRow(row: any): MobileItemRecord {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    itemType: row.item_type,
    title: row.title,
    summary: row.summary,
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    salience: Number(row.salience ?? 0),
    confidence: Number(row.confidence ?? 0),
    dedupeKey: row.dedupe_key ?? null,
    status: row.status,
    occurredAt: row.occurred_at,
    availableAt: row.available_at,
    expiresAt: row.expires_at ?? null,
    processedAt: row.processed_at ?? null,
    createdAt: row.created_at,
  };
}

export function ingestMobileItems(payload: MobileIngestPayload): { accepted: number; inserted: number; ignored: number } {
  const db = resolveMobileDb();
  const accepted = payload.items.length;
  let inserted = 0;
  const createdAt = nowIso();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO mobile_items (
      id, user_id, device_id, item_type, title, summary, payload_json, salience, confidence, dedupe_key,
      status, occurred_at, available_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `);
  const insertBatch = db.prepare(`
    INSERT INTO mobile_ingest_batches (
      id, device_id, accepted_count, inserted_count, ignored_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    payload.items.forEach((item) => {
      const occurredAt = normalizeIso(item.occurredAt, createdAt);
      const availableAt = normalizeIso(item.availableAt, occurredAt);
      const expiresAt = normalizeExpiresAt(occurredAt, item.expiresAt);
      const result = insert.run(
        item.id,
        MOBILE_USER_ID,
        payload.deviceId,
        item.itemType,
        item.title,
        item.summary,
        JSON.stringify(item.payload ?? {}),
        item.salience ?? 0,
        item.confidence ?? 0,
        item.dedupeKey?.trim() || null,
        occurredAt,
        availableAt,
        expiresAt,
        createdAt,
      );
      inserted += result.changes;
    });
    insertBatch.run(
      crypto.randomUUID(),
      payload.deviceId,
      accepted,
      inserted,
      accepted - inserted,
      createdAt,
    );
  });
  tx();

  return { accepted, inserted, ignored: accepted - inserted };
}

export function listMobileItems(filters: ListMobileItemsFilters = {}): MobileItemRecord[] {
  const db = resolveMobileDb();
  expireElapsedMobileItems();
  const parts = ["SELECT * FROM mobile_items WHERE 1=1"];
  const args: Array<string | number> = [];
  if (filters.status) {
    parts.push("AND status = ?");
    args.push(filters.status);
  }
  if (filters.itemType) {
    parts.push("AND item_type = ?");
    args.push(filters.itemType);
  }
  if (filters.since) {
    parts.push("AND occurred_at >= ?");
    args.push(normalizeIso(filters.since, filters.since));
  }
  if (filters.until) {
    parts.push("AND occurred_at <= ?");
    args.push(normalizeIso(filters.until, filters.until));
  }
  if (filters.deviceId) {
    parts.push("AND device_id = ?");
    args.push(filters.deviceId);
  }
  const order = normalizeOrder(filters.order);
  parts.push(`ORDER BY occurred_at ${order}, created_at ${order}`);
  parts.push("LIMIT ?");
  args.push(Math.max(1, Math.min(filters.limit ?? 50, 200)));
  return resolveMobileDb().prepare(parts.join(" ")).all(...args).map(mapRow);
}

export function claimMobileItems(filters: ListMobileItemsFilters & { limit?: number }): MobileClaimResult {
  const db = resolveMobileDb();
  const limit = Math.max(1, Math.min(filters.limit ?? 20, 200));
  const cutoff = nowIso();
  const runToken = crypto.randomUUID();

  const claimTx = db.transaction(() => {
    expireElapsedMobileItems(cutoff);
    expireOldMobileItemRuns(DEFAULT_RUN_TTL_MS);

    const parts = [
      "SELECT * FROM mobile_items",
      "WHERE status = 'pending'",
      "AND available_at <= ?",
      "AND (expires_at IS NULL OR expires_at > ?)",
    ];
    const args: Array<string | number> = [cutoff, cutoff];

    if (filters.itemType) {
      parts.push("AND item_type = ?");
      args.push(filters.itemType);
    }
    if (filters.since) {
      parts.push("AND occurred_at >= ?");
      args.push(normalizeIso(filters.since, filters.since));
    }
    if (filters.until) {
      parts.push("AND occurred_at <= ?");
      args.push(normalizeIso(filters.until, filters.until));
    }
    if (filters.deviceId) {
      parts.push("AND device_id = ?");
      args.push(filters.deviceId);
    }

    parts.push("ORDER BY available_at ASC, salience DESC, occurred_at ASC");
    parts.push("LIMIT ?");
    args.push(limit);

    const rows = db.prepare(parts.join(" ")).all(...args).map(mapRow);
    if (rows.length === 0) {
      return { runToken: null, items: [] };
    }

    const ids = rows.map((item) => item.id);
    db.prepare(
      `UPDATE mobile_items SET status = 'claimed' WHERE id IN (${placeholders(ids.length)})`,
    ).run(...ids);
    db.prepare(
      "INSERT INTO mobile_item_runs (run_token, item_ids_json, item_count, created_at, status) VALUES (?, ?, ?, ?, 'open')",
    ).run(runToken, JSON.stringify(ids), ids.length, cutoff);
    return { runToken, items: rows };
  });

  return claimTx();
}

export function commitMobileItemRun(runToken: string): { processed: number } {
  const db = resolveMobileDb();
  const committedAt = nowIso();

  const commitTx = db.transaction(() => {
    const run = db.prepare("SELECT * FROM mobile_item_runs WHERE run_token = ?").get(runToken) as any;
    if (!run) {
      return { processed: 0 };
    }
    const itemIds = parseJson<string[]>(run.item_ids_json);
    if (itemIds.length === 0) {
      db.prepare("UPDATE mobile_item_runs SET status = 'committed', committed_at = ? WHERE run_token = ?")
        .run(committedAt, runToken);
      return { processed: 0 };
    }

    const result = db.prepare(
      `UPDATE mobile_items
         SET status = 'processed', processed_at = ?
       WHERE id IN (${placeholders(itemIds.length)}) AND status = 'claimed'`,
    ).run(committedAt, ...itemIds);
    db.prepare("UPDATE mobile_item_runs SET status = 'committed', committed_at = ? WHERE run_token = ?")
      .run(committedAt, runToken);
    return { processed: result.changes };
  });

  return commitTx();
}

export function expireOldMobileItemRuns(maxAgeMs = DEFAULT_RUN_TTL_MS): number {
  const db = resolveMobileDb();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const expiredAt = nowIso();
  const staleRuns = db.prepare(
    "SELECT run_token, item_ids_json FROM mobile_item_runs WHERE status = 'open' AND created_at < ?",
  ).all(cutoff) as Array<{ run_token: string; item_ids_json: string }>;
  if (staleRuns.length === 0) return 0;

  const tx = db.transaction(() => {
    staleRuns.forEach((run) => {
      const itemIds = parseJson<string[]>(run.item_ids_json);
      if (itemIds.length > 0) {
        db.prepare(
          `UPDATE mobile_items
             SET status = 'pending'
           WHERE id IN (${placeholders(itemIds.length)})
             AND status = 'claimed'
             AND (expires_at IS NULL OR expires_at > ?)`,
        ).run(...itemIds, expiredAt);
        db.prepare(
          `UPDATE mobile_items
             SET status = 'expired'
           WHERE id IN (${placeholders(itemIds.length)})
             AND status = 'claimed'
             AND expires_at IS NOT NULL
             AND expires_at <= ?`,
        ).run(...itemIds, expiredAt);
      }
      db.prepare(
        "UPDATE mobile_item_runs SET status = 'expired' WHERE run_token = ?",
      ).run(run.run_token);
    });
  });
  tx();

  return staleRuns.length;
}

function expireElapsedMobileItems(cutoff = nowIso()): number {
  const db = resolveMobileDb();
  const result = db.prepare(
    "UPDATE mobile_items SET status = 'expired' WHERE status IN ('pending', 'claimed') AND expires_at IS NOT NULL AND expires_at <= ?",
  ).run(cutoff);
  return result.changes;
}

export function resetMobileDbForTests(): void {
  if (mobileDb) {
    mobileDb.close();
    mobileDb = null;
  }
}
