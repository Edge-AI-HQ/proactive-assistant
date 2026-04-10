import { dirname } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";

import { appPaths } from "../../core/paths.js";

export type DreamTrigger = "auto" | "manual";
export type DreamRunStatus = "running" | "completed" | "failed";

export interface DreamSummary {
  kind: string;
  text: string;
  sourceCount: number;
  candidateCount: number;
  [key: string]: unknown;
}

export interface DreamProfileFieldDelta<T> {
  before: T;
  after: T;
}

export interface DreamProfileDelta {
  facts: DreamProfileFieldDelta<Record<string, unknown>>;
  preferences: DreamProfileFieldDelta<Record<string, unknown>>;
  interests: DreamProfileFieldDelta<Array<Record<string, unknown>>>;
  snapshots: DreamProfileFieldDelta<Array<Record<string, unknown>>>;
}

export interface DreamGoalDeltaChange {
  action: "create" | "update" | "close";
  key: string;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface DreamGoalDelta {
  changes: DreamGoalDeltaChange[];
}

export interface DreamRunRecord {
  id: string;
  trigger: DreamTrigger;
  status: DreamRunStatus;
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  completedAt: string | null;
  sourceStatsJson: Record<string, unknown> | null;
  summaryJson: DreamSummary | null;
  profileDeltaJson: DreamProfileDelta | null;
  goalDeltaJson: DreamGoalDelta | null;
  artifactDir: string | null;
  appliedAt: string | null;
  goalsAppliedAt: string | null;
  errorMessage: string | null;
  superseded: boolean;
}

interface CreateDreamRunInput {
  trigger: DreamTrigger;
  windowStart: string;
  windowEnd: string;
}

interface CompleteDreamRunInput {
  artifactDir: string;
  sourceStats: Record<string, unknown>;
  summary: DreamSummary;
  profileDelta: DreamProfileDelta;
  goalDelta: DreamGoalDelta;
  completedAt?: string;
}

function asObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  return JSON.parse(value) as Record<string, unknown>;
}

function getDbPath(root: string): string {
  const dbPath = appPaths.pinDb(root);
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dbPath;
}

function nextRunId(): string {
  return `dream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class DreamRunStore {
  private readonly db: Database.Database;

  constructor(private readonly root: string) {
    this.db = new Database(getDbPath(root));
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_dream_runs (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL CHECK (trigger IN ('auto', 'manual')),
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        source_stats_json TEXT,
        summary_json TEXT,
        profile_delta_json TEXT,
        goal_delta_json TEXT,
        artifact_dir TEXT,
        applied_at TEXT,
        goals_applied_at TEXT,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_proactive_dream_runs_completed_at
        ON proactive_dream_runs(completed_at DESC);
    `);

    const columns = this.db.prepare(`PRAGMA table_info(proactive_dream_runs)`).all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("goal_delta_json")) {
      this.db.exec(`ALTER TABLE proactive_dream_runs ADD COLUMN goal_delta_json TEXT`);
    }
    if (!columnNames.has("goals_applied_at")) {
      this.db.exec(`ALTER TABLE proactive_dream_runs ADD COLUMN goals_applied_at TEXT`);
    }
  }

  private rowToRecord(row: Record<string, unknown> | undefined): DreamRunRecord | null {
    if (!row) return null;
    const base: DreamRunRecord = {
      id: String(row.id),
      trigger: row.trigger as DreamTrigger,
      status: row.status as DreamRunStatus,
      windowStart: String(row.window_start),
      windowEnd: String(row.window_end),
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      sourceStatsJson: asObject((row.source_stats_json as string | null) ?? null),
      summaryJson: (asObject((row.summary_json as string | null) ?? null) as DreamSummary | null),
      profileDeltaJson: (asObject((row.profile_delta_json as string | null) ?? null) as DreamProfileDelta | null),
      goalDeltaJson: (asObject((row.goal_delta_json as string | null) ?? null) as DreamGoalDelta | null),
      artifactDir: row.artifact_dir ? String(row.artifact_dir) : null,
      appliedAt: row.applied_at ? String(row.applied_at) : null,
      goalsAppliedAt: row.goals_applied_at ? String(row.goals_applied_at) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      superseded: false,
    };
    base.superseded = this.isSuperseded(base.id, base.completedAt);
    return base;
  }

  private isSuperseded(runId: string, completedAt: string | null): boolean {
    if (!completedAt) return false;
    const row = this.db.prepare(`
      SELECT id
      FROM proactive_dream_runs
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND (
          completed_at > ?
          OR (completed_at = ? AND id != ?)
        )
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `).get(completedAt, completedAt, runId) as { id: string } | undefined;
    return !!row;
  }

  createRun(input: CreateDreamRunInput): DreamRunRecord {
    const now = new Date().toISOString();
    const id = nextRunId();
    this.db.prepare(`
      INSERT INTO proactive_dream_runs
      (id, trigger, status, window_start, window_end, started_at)
      VALUES (?, ?, 'running', ?, ?, ?)
    `).run(id, input.trigger, input.windowStart, input.windowEnd, now);
    return this.getRun(id) as DreamRunRecord;
  }

  completeRun(id: string, input: CompleteDreamRunInput): DreamRunRecord {
    const completedAt = input.completedAt ?? new Date().toISOString();
    this.db.prepare(`
      UPDATE proactive_dream_runs
      SET status = 'completed',
          completed_at = ?,
          source_stats_json = ?,
          summary_json = ?,
          profile_delta_json = ?,
          goal_delta_json = ?,
          artifact_dir = ?,
          error_message = NULL
      WHERE id = ?
    `).run(
      completedAt,
      JSON.stringify(input.sourceStats),
      JSON.stringify(input.summary),
      JSON.stringify(input.profileDelta),
      JSON.stringify(input.goalDelta),
      input.artifactDir,
      id,
    );
    return this.getRun(id) as DreamRunRecord;
  }

  failRun(id: string, errorMessage: string, completedAt = new Date().toISOString()): DreamRunRecord {
    this.db.prepare(`
      UPDATE proactive_dream_runs
      SET status = 'failed',
          completed_at = ?,
          error_message = ?
      WHERE id = ?
    `).run(completedAt, errorMessage, id);
    return this.getRun(id) as DreamRunRecord;
  }

  getRun(id: string): DreamRunRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM proactive_dream_runs
      WHERE id = ?
      LIMIT 1
    `).get(id) as Record<string, unknown> | undefined;
    return this.rowToRecord(row);
  }

  listRuns(limit = 30): DreamRunRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM proactive_dream_runs
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.rowToRecord(row))
      .filter((row): row is DreamRunRecord => row !== null);
  }

  getLatestSuccessfulRun(trigger?: DreamTrigger): DreamRunRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM proactive_dream_runs
      WHERE status = 'completed'
        ${trigger ? "AND trigger = ?" : ""}
      ORDER BY completed_at DESC, id DESC
      LIMIT 1
    `).get(...(trigger ? [trigger] : [])) as Record<string, unknown> | undefined;
    return this.rowToRecord(row);
  }

  assertCanApply(id: string): DreamRunRecord {
    const run = this.getRun(id);
    if (!run) {
      throw new Error(`Dream run ${id} not found`);
    }
    if (run.appliedAt) {
      return run;
    }
    if (run.superseded) {
      throw new Error(`Dream run ${id} is superseded and cannot be applied`);
    }
    if (run.status !== "completed") {
      throw new Error(`Dream run ${id} is not completed`);
    }
    return run;
  }

  markApplied(id: string, appliedAt = new Date().toISOString()): DreamRunRecord {
    const run = this.assertCanApply(id);
    if (run.appliedAt) {
      return run;
    }
    this.db.prepare(`
      UPDATE proactive_dream_runs
      SET applied_at = ?
      WHERE id = ?
    `).run(appliedAt, id);
    return this.getRun(id) as DreamRunRecord;
  }

  assertCanApplyGoals(id: string): DreamRunRecord {
    const run = this.getRun(id);
    if (!run) {
      throw new Error(`Dream run ${id} not found`);
    }
    if (run.goalsAppliedAt) {
      return run;
    }
    if (run.superseded) {
      throw new Error(`Dream run ${id} is superseded and cannot apply goal changes`);
    }
    if (run.status !== "completed") {
      throw new Error(`Dream run ${id} is not completed`);
    }
    return run;
  }

  markGoalsApplied(id: string, appliedAt = new Date().toISOString()): DreamRunRecord {
    const run = this.assertCanApplyGoals(id);
    if (run.goalsAppliedAt) {
      return run;
    }
    this.db.prepare(`
      UPDATE proactive_dream_runs
      SET goals_applied_at = ?
      WHERE id = ?
    `).run(appliedAt, id);
    return this.getRun(id) as DreamRunRecord;
  }

  prune(limit = 30): DreamRunRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM proactive_dream_runs
      ORDER BY started_at DESC, id DESC
    `).all() as Array<Record<string, unknown>>;
    const keep = rows.slice(0, limit);
    const remove = rows.slice(limit);

    if (remove.length > 0) {
      const deleteStmt = this.db.prepare(`DELETE FROM proactive_dream_runs WHERE id = ?`);
      const tx = this.db.transaction((runIds: string[]) => {
        for (const runId of runIds) deleteStmt.run(runId);
      });
      tx(remove.map((row) => String(row.id)));
      for (const row of remove) {
        const artifactDir = row.artifact_dir ? String(row.artifact_dir) : null;
        if (artifactDir) {
          rmSync(artifactDir, { recursive: true, force: true });
        }
      }
    }

    return keep
      .map((row) => this.rowToRecord(row))
      .filter((row): row is DreamRunRecord => row !== null);
  }
}
