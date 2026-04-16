import crypto from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import type { CliRuntimeInput } from "../../runtime.js";

const DEFAULT_RUN_TTL_MS = 15 * 60 * 1000;

export interface MobileListFilters {
  status?: string;
  itemType?: string;
  since?: string;
  until?: string;
  deviceId?: string;
  limit?: number;
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

export interface MobileClaimResult {
  runToken: string | null;
  items: MobileItemRecord[];
}

function normalizeIso(value: string | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function clampLimit(limit?: number, fallback = 50): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(Math.trunc(limit ?? fallback), 200));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function collectAncestorDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = start;
  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function discoverMobileDbPath(): string | null {
  const matches: Array<{ path: string; mtimeMs: number }> = [];

  for (const root of collectAncestorDirs(process.cwd())) {
    const dataDir = join(root, "data");
    if (!existsSync(dataDir)) continue;

    const directDb = join(dataDir, "mobile_items.db");
    if (existsSync(directDb)) {
      matches.push({ path: directDb, mtimeMs: statSync(directDb).mtimeMs });
    }

    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nestedCandidates = [
        join(dataDir, entry.name, "mobile_items.db"),
        join(dataDir, entry.name, "data", "mobile_items.db"),
      ];
      for (const dbPath of nestedCandidates) {
        if (!existsSync(dbPath)) continue;
        matches.push({ path: dbPath, mtimeMs: statSync(dbPath).mtimeMs });
      }
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path ?? null;
}

export function resolveMobileDbPath(runtime: CliRuntimeInput): string {
  const explicitDbPath = runtime.env.PIN_MOBILE_DB_PATH?.trim();
  if (explicitDbPath) {
    if (!existsSync(explicitDbPath)) {
      throw new Error(`PIN_MOBILE_DB_PATH does not exist: ${explicitDbPath}`);
    }
    return explicitDbPath;
  }

  const explicitDataRoot = runtime.env.PIN_MOBILE_DATA_ROOT?.trim();
  if (explicitDataRoot) {
    const fromDataRoot = [
      join(explicitDataRoot, "mobile_items.db"),
      join(explicitDataRoot, "data", "mobile_items.db"),
    ].find((candidate) => existsSync(candidate));
    if (!fromDataRoot) {
      throw new Error(`PIN_MOBILE_DATA_ROOT does not contain mobile_items.db: ${explicitDataRoot}`);
    }
    return fromDataRoot;
  }

  const openClawHome = runtime.env.OPENCLAW_HOME?.trim();
  if (openClawHome) {
    const fromOpenClaw = join(openClawHome, "data", "mobile_items.db");
    if (existsSync(fromOpenClaw)) return fromOpenClaw;
  }

  const discovered = discoverMobileDbPath();
  if (discovered) return discovered;

  throw new Error(
    "No local mobile_items.db found. Set PIN_MOBILE_DB_PATH, set PIN_MOBILE_DATA_ROOT, or run from a repo containing data/proactive-*/mobile_items.db.",
  );
}

function openMobileDb(runtime: CliRuntimeInput): Database.Database {
  const db = new Database(resolveMobileDbPath(runtime));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

function mapRow(row: Record<string, unknown>): MobileItemRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    deviceId: String(row.device_id),
    itemType: String(row.item_type),
    title: String(row.title),
    summary: String(row.summary),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    salience: Number(row.salience ?? 0),
    confidence: Number(row.confidence ?? 0),
    dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null,
    status: String(row.status) as MobileItemRecord["status"],
    occurredAt: String(row.occurred_at),
    availableAt: String(row.available_at),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    processedAt: row.processed_at ? String(row.processed_at) : null,
    createdAt: String(row.created_at),
  };
}

function expireElapsedMobileItems(db: Database.Database, cutoff = new Date().toISOString()): number {
  const result = db.prepare(
    "UPDATE mobile_items SET status = 'expired' WHERE status IN ('pending', 'claimed') AND expires_at IS NOT NULL AND expires_at <= ?",
  ).run(cutoff);
  return result.changes;
}

function expireOldMobileItemRuns(db: Database.Database, maxAgeMs = DEFAULT_RUN_TTL_MS): number {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const now = new Date().toISOString();
  const staleRuns = db.prepare(
    "SELECT run_token, item_ids_json FROM mobile_item_runs WHERE status = 'open' AND created_at < ?",
  ).all(cutoff) as Array<{ run_token: string; item_ids_json: string }>;

  if (staleRuns.length === 0) return 0;

  const tx = db.transaction(() => {
    staleRuns.forEach((run) => {
      const itemIds = JSON.parse(run.item_ids_json) as string[];
      if (itemIds.length > 0) {
        db.prepare(
          `UPDATE mobile_items
             SET status = 'pending'
           WHERE id IN (${placeholders(itemIds.length)})
             AND status = 'claimed'
             AND (expires_at IS NULL OR expires_at > ?)`,
        ).run(...itemIds, now);
        db.prepare(
          `UPDATE mobile_items
             SET status = 'expired'
           WHERE id IN (${placeholders(itemIds.length)})
             AND status = 'claimed'
             AND expires_at IS NOT NULL
             AND expires_at <= ?`,
        ).run(...itemIds, now);
      }
      db.prepare("UPDATE mobile_item_runs SET status = 'expired' WHERE run_token = ?").run(run.run_token);
    });
  });

  tx();
  return staleRuns.length;
}

export function listMobileItems(runtime: CliRuntimeInput, filters: MobileListFilters = {}): MobileItemRecord[] {
  const db = openMobileDb(runtime);
  try {
    expireElapsedMobileItems(db);
    const sql = ["SELECT * FROM mobile_items WHERE 1=1"];
    const args: Array<string | number> = [];

    if (filters.status) {
      sql.push("AND status = ?");
      args.push(filters.status);
    }
    if (filters.itemType) {
      sql.push("AND item_type = ?");
      args.push(filters.itemType);
    }
    if (filters.since) {
      const since = normalizeIso(filters.since);
      if (since) {
        sql.push("AND occurred_at >= ?");
        args.push(since);
      }
    }
    if (filters.until) {
      const until = normalizeIso(filters.until);
      if (until) {
        sql.push("AND occurred_at <= ?");
        args.push(until);
      }
    }
    if (filters.deviceId) {
      sql.push("AND device_id = ?");
      args.push(filters.deviceId);
    }

    sql.push("ORDER BY occurred_at ASC");
    sql.push("LIMIT ?");
    args.push(clampLimit(filters.limit));

    return db.prepare(sql.join(" ")).all(...args).map((row) => mapRow(row as Record<string, unknown>));
  } finally {
    db.close();
  }
}

export function claimMobileItems(runtime: CliRuntimeInput, filters: MobileListFilters = {}): MobileClaimResult {
  const db = openMobileDb(runtime);
  try {
    const limit = clampLimit(filters.limit, 20);
    const cutoff = new Date().toISOString();
    const runToken = crypto.randomUUID();

    const tx = db.transaction(() => {
      expireElapsedMobileItems(db, cutoff);
      expireOldMobileItemRuns(db);

      const sql = [
        "SELECT * FROM mobile_items",
        "WHERE status = 'pending'",
        "AND available_at <= ?",
        "AND (expires_at IS NULL OR expires_at > ?)",
      ];
      const args: Array<string | number> = [cutoff, cutoff];

      if (filters.itemType) {
        sql.push("AND item_type = ?");
        args.push(filters.itemType);
      }
      if (filters.since) {
        const since = normalizeIso(filters.since);
        if (since) {
          sql.push("AND occurred_at >= ?");
          args.push(since);
        }
      }
      if (filters.until) {
        const until = normalizeIso(filters.until);
        if (until) {
          sql.push("AND occurred_at <= ?");
          args.push(until);
        }
      }
      if (filters.deviceId) {
        sql.push("AND device_id = ?");
        args.push(filters.deviceId);
      }

      sql.push("ORDER BY available_at ASC, salience DESC, occurred_at ASC");
      sql.push("LIMIT ?");
      args.push(limit);

      const items = db.prepare(sql.join(" ")).all(...args).map((row) => mapRow(row as Record<string, unknown>));
      if (items.length === 0) return { runToken: null, items: [] };

      const ids = items.map((item) => item.id);
      db.prepare(`UPDATE mobile_items SET status = 'claimed' WHERE id IN (${placeholders(ids.length)})`).run(...ids);
      db.prepare(
        "INSERT INTO mobile_item_runs (run_token, item_ids_json, item_count, created_at, status) VALUES (?, ?, ?, ?, 'open')",
      ).run(runToken, JSON.stringify(ids), ids.length, cutoff);
      return { runToken, items };
    });

    return tx();
  } finally {
    db.close();
  }
}

export function commitMobileItemRun(runtime: CliRuntimeInput, runToken: string): { processed: number } {
  const db = openMobileDb(runtime);
  try {
    const committedAt = new Date().toISOString();
    const tx = db.transaction(() => {
      const run = db.prepare("SELECT * FROM mobile_item_runs WHERE run_token = ?").get(runToken) as
        | { item_ids_json: string }
        | undefined;
      if (!run) return { processed: 0 };

      const itemIds = JSON.parse(run.item_ids_json) as string[];
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

    return tx();
  } finally {
    db.close();
  }
}
