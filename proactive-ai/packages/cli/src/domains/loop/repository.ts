import { randomUUID } from "node:crypto";

import { SqliteDatabase } from "../../db/sqlite_adapter.js";

export type PendingSource = "world" | "personal";
export type PendingStatus = "pending" | "processed";
export type LoopRunStatus = "open" | "committed" | "expired";
export type AutoLoopStatus = "success" | "error";

export interface PendingItemInput {
  id: string;
  source: PendingSource;
  kind: string;
  createdAt: string;
  availableAt: string;
  status: PendingStatus;
  processedAt: string | null;
  payload: Record<string, unknown>;
}

export interface PendingItemRecord extends PendingItemInput {}

export interface IncrementalContextRun {
  runToken: string;
  generatedAt: string;
  items: PendingItemRecord[];
  pendingCount: number;
  oldestPendingAt: string | null;
}

export interface EnqueuePendingInput {
  worldCursorUpdatedAt?: string | null;
  personalSnapshotHash?: string | null;
  items: PendingItemInput[];
}

export interface EnqueuePendingResult {
  insertedCount: number;
  insertedBySource: Record<PendingSource, number>;
  pendingCount: number;
}

export interface LoopStatusRecord {
  pendingCount: number;
  processedCount: number;
  openRunCount: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: AutoLoopStatus | null;
}

export class LoopRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  async enqueuePending(input: EnqueuePendingInput): Promise<EnqueuePendingResult> {
    await this.ensureSchema();

    let insertedCount = 0;
    const insertedBySource: Record<PendingSource, number> = {
      world: 0,
      personal: 0,
    };

    const insertStmt = this.database.client.prepare(`
      INSERT OR IGNORE INTO proactive_pending
      (id, source, kind, payload_json, created_at, available_at, status, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertCursorStmt = this.database.client.prepare(`
      INSERT INTO proactive_ingest_cursor(source, cursor, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at
    `);

    const tx = this.database.client.transaction(() => {
      for (const item of input.items) {
        const result = insertStmt.run(
          item.id,
          item.source,
          item.kind,
          JSON.stringify(item.payload ?? {}),
          item.createdAt,
          item.availableAt,
          item.status,
          item.processedAt,
        );
        if (result.changes > 0) {
          insertedCount += 1;
          insertedBySource[item.source] += 1;
        }
      }

      const nowIso = new Date().toISOString();
      if (typeof input.worldCursorUpdatedAt === "string") {
        upsertCursorStmt.run("world", input.worldCursorUpdatedAt, nowIso);
      }
      if (typeof input.personalSnapshotHash === "string") {
        upsertCursorStmt.run("personal", input.personalSnapshotHash, nowIso);
      }
    });

    tx();

    return {
      insertedCount,
      insertedBySource,
      pendingCount: this.getPendingCount(),
    };
  }

  async createIncrementalContextRun(input: {
    limit: number;
    minAgeMs: number;
  }): Promise<IncrementalContextRun | null> {
    await this.ensureSchema();

    const thresholdIso = new Date(Date.now() - Math.max(0, input.minAgeMs)).toISOString();
    const nowIso = new Date().toISOString();
    const rows = this.database.all<{
      id: string;
      source: PendingSource;
      kind: string;
      payload_json: string;
      created_at: string;
      available_at: string;
      status: PendingStatus;
      processed_at: string | null;
    }>(
      `
        SELECT id, source, kind, payload_json, created_at, available_at, status, processed_at
        FROM proactive_pending
        WHERE status = 'pending'
          AND created_at <= ?
          AND available_at <= ?
        ORDER BY created_at ASC
        LIMIT ?
      `,
      [thresholdIso, nowIso, Math.max(1, input.limit)],
    );

    if (rows.length === 0) return null;

    const items = rows.map((row) => ({
      id: row.id,
      source: row.source,
      kind: row.kind,
      createdAt: row.created_at,
      availableAt: row.available_at,
      status: row.status,
      processedAt: row.processed_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));

    const runToken = `inc_${randomUUID()}`;
    this.database.exec(
      `
        INSERT INTO proactive_context_runs(run_token, item_ids_json, item_count, created_at, status, committed_at)
        VALUES (?, ?, ?, ?, 'open', NULL)
      `,
      [runToken, JSON.stringify(items.map((item) => item.id)), items.length, nowIso],
    );

    return {
      runToken,
      generatedAt: nowIso,
      items,
      pendingCount: this.getPendingCount(),
      oldestPendingAt: this.getOldestPendingAt(),
    };
  }

  async commitContextRun(runToken: string, committedAt: string): Promise<{ processedCount: number }> {
    await this.ensureSchema();

    const row = this.database.get<{
      run_token: string;
      item_ids_json: string;
      status: LoopRunStatus;
    }>(
      `
        SELECT run_token, item_ids_json, status
        FROM proactive_context_runs
        WHERE run_token = ?
        LIMIT 1
      `,
      [runToken],
    );

    if (!row) {
      throw new Error("RUN_TOKEN_NOT_FOUND");
    }
    if (row.status !== "open") {
      throw new Error("RUN_TOKEN_NOT_OPEN");
    }

    const itemIds = JSON.parse(row.item_ids_json) as string[];
    const markStmt = this.database.client.prepare(`
      UPDATE proactive_pending
      SET status = 'processed', processed_at = ?
      WHERE id = ? AND status = 'pending'
    `);

    let processedCount = 0;
    const tx = this.database.client.transaction(() => {
      for (const itemId of itemIds) {
        const result = markStmt.run(committedAt, itemId);
        processedCount += Number(result.changes ?? 0);
      }
      this.database.exec(
        `
          UPDATE proactive_context_runs
          SET status = 'committed', committed_at = ?
          WHERE run_token = ?
        `,
        [committedAt, runToken],
      );
    });

    tx();
    return { processedCount };
  }

  async getLoopStatus(): Promise<LoopStatusRecord> {
    await this.ensureSchema();
    return {
      pendingCount: this.getCountByStatus("pending"),
      processedCount: this.getCountByStatus("processed"),
      openRunCount: this.database.get<{ c: number }>(
        "SELECT COUNT(1) AS c FROM proactive_context_runs WHERE status = 'open'",
      )?.c ?? 0,
      lastStartedAt: this.readLoopStateValue("last_started_at"),
      lastFinishedAt: this.readLoopStateValue("last_finished_at"),
      lastStatus: (this.readLoopStateValue("last_status") as AutoLoopStatus | null) ?? null,
    };
  }

  async loadIngestState(): Promise<{
    worldCursorUpdatedAt: string | null;
    personalSnapshotHash: string | null;
  }> {
    await this.ensureSchema();
    return {
      worldCursorUpdatedAt: this.readCursor("world"),
      personalSnapshotHash: this.readCursor("personal"),
    };
  }

  async saveLoopState(input: {
    lastStartedAt?: string | null;
    lastFinishedAt?: string | null;
    lastStatus?: AutoLoopStatus | null;
  }): Promise<void> {
    await this.ensureSchema();
    if (input.lastStartedAt !== undefined) {
      this.writeLoopStateValue("last_started_at", input.lastStartedAt);
    }
    if (input.lastFinishedAt !== undefined) {
      this.writeLoopStateValue("last_finished_at", input.lastFinishedAt);
    }
    if (input.lastStatus !== undefined) {
      this.writeLoopStateValue("last_status", input.lastStatus);
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS proactive_ingest_cursor (
        source TEXT PRIMARY KEY,
        cursor TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proactive_pending (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        available_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processed')),
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_proactive_pending_status_available
        ON proactive_pending(status, available_at);

      CREATE TABLE IF NOT EXISTS proactive_loop_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proactive_context_runs (
        run_token TEXT PRIMARY KEY,
        item_ids_json TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'committed', 'expired')),
        committed_at TEXT
      );
    `);
    this.schemaReady = true;
  }

  private readCursor(source: PendingSource): string | null {
    const row = this.database.get<{ cursor: string | null }>(
      "SELECT cursor FROM proactive_ingest_cursor WHERE source = ? LIMIT 1",
      [source],
    );
    return row?.cursor ?? null;
  }

  private getPendingCount(): number {
    return this.getCountByStatus("pending");
  }

  private getCountByStatus(status: PendingStatus): number {
    return this.database.get<{ c: number }>(
      "SELECT COUNT(1) AS c FROM proactive_pending WHERE status = ?",
      [status],
    )?.c ?? 0;
  }

  private getOldestPendingAt(): string | null {
    const row = this.database.get<{ created_at: string | null }>(
      "SELECT MIN(created_at) AS created_at FROM proactive_pending WHERE status = 'pending'",
    );
    return row?.created_at ?? null;
  }

  private readLoopStateValue(key: string): string | null {
    const row = this.database.get<{ value: string | null }>(
      "SELECT value FROM proactive_loop_state WHERE key = ? LIMIT 1",
      [key],
    );
    return row?.value ?? null;
  }

  private writeLoopStateValue(key: string, value: string | null): void {
    this.database.exec(
      `
        INSERT INTO proactive_loop_state(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `,
      [key, value, new Date().toISOString()],
    );
  }
}
