/**
 * Local SQLite-backed dream run storage.
 * Uses the shared DB instance from db.ts.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type {
  DreamTrigger,
  DreamRunRecord,
  DreamSummary,
  DreamProfileDelta,
  DreamGoalDelta,
} from './types.js';

// ── Shared DB access ──
// We reuse the same database file as db.ts but get our own handle
// to avoid circular imports.  WAL mode allows concurrent readers.

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const home = process.env.OPENCLAW_HOME || '/app';
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'proactive.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  // Schema is ensured by the main db.ts module; the dream_runs table
  // is created there.  We do a safety check here in case store.ts
  // is loaded before db.ts.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS dream_runs (
      id TEXT PRIMARY KEY,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('auto', 'manual')),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      source_stats TEXT,
      summary TEXT,
      profile_delta TEXT,
      goal_delta TEXT,
      journal_markdown TEXT,
      candidates TEXT,
      applied_at TEXT,
      goals_applied_at TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dream_started ON dream_runs(started_at DESC);
  `);
  return _db;
}

function nextRunId(): string {
  return `dream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function parseJsonArray<T>(raw: string | null | undefined): T[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function isSuperseded(runId: string, completedAt: string | null): boolean {
  if (!completedAt) return false;
  const row = getDb().prepare(`
    SELECT id FROM dream_runs
    WHERE status = 'completed'
      AND completed_at IS NOT NULL
      AND (completed_at > ? OR (completed_at = ? AND id != ?))
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `).get(completedAt, completedAt, runId) as { id: string } | undefined;
  return !!row;
}

function rowToRecord(row: Record<string, any>): DreamRunRecord {
  const base: DreamRunRecord = {
    id: row.id,
    trigger: row.trigger_kind as DreamTrigger,
    status: row.status,
    window_start: row.window_start,
    window_end: row.window_end,
    started_at: row.started_at,
    completed_at: row.completed_at ?? null,
    source_stats: parseJson(row.source_stats),
    summary: parseJson<DreamSummary>(row.summary),
    profile_delta: parseJson<DreamProfileDelta>(row.profile_delta),
    goal_delta: parseJson<DreamGoalDelta>(row.goal_delta),
    journal_markdown: row.journal_markdown ?? null,
    candidates: parseJsonArray<Record<string, unknown>>(row.candidates),
    applied_at: row.applied_at ?? null,
    goals_applied_at: row.goals_applied_at ?? null,
    error_message: row.error_message ?? null,
    superseded: false,
  };
  base.superseded = isSuperseded(base.id, base.completed_at);
  return base;
}

export async function createRun(input: {
  trigger: DreamTrigger;
  windowStart: string;
  windowEnd: string;
}): Promise<DreamRunRecord> {
  const id = nextRunId();
  const ts = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO dream_runs (id, trigger_kind, status, window_start, window_end, started_at)
    VALUES (?, ?, 'running', ?, ?, ?)
  `).run(id, input.trigger, input.windowStart, input.windowEnd, ts);
  const row = getDb().prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as any;
  return rowToRecord(row);
}

export async function completeRun(id: string, input: {
  sourceStats: Record<string, unknown>;
  summary: DreamSummary;
  profileDelta: DreamProfileDelta;
  goalDelta: DreamGoalDelta;
  journalMarkdown: string | null;
  candidates: Array<Record<string, unknown>>;
  completedAt?: string;
}): Promise<DreamRunRecord> {
  const ts = input.completedAt ?? new Date().toISOString();
  getDb().prepare(`
    UPDATE dream_runs SET
      status = 'completed',
      completed_at = ?,
      source_stats = ?,
      summary = ?,
      profile_delta = ?,
      goal_delta = ?,
      journal_markdown = ?,
      candidates = ?,
      error_message = NULL
    WHERE id = ?
  `).run(ts, JSON.stringify(input.sourceStats), JSON.stringify(input.summary),
    JSON.stringify(input.profileDelta), JSON.stringify(input.goalDelta),
    input.journalMarkdown, JSON.stringify(input.candidates), id);
  const row = getDb().prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as any;
  if (!row) throw new Error(`Dream run not found: ${id}`);
  return rowToRecord(row);
}

export async function failRun(id: string, errorMessage: string): Promise<DreamRunRecord> {
  const ts = new Date().toISOString();
  getDb().prepare(`
    UPDATE dream_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?
  `).run(ts, errorMessage, id);
  const row = getDb().prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as any;
  if (!row) throw new Error(`Dream run not found: ${id}`);
  return rowToRecord(row);
}

export async function getRun(id: string): Promise<DreamRunRecord | null> {
  const row = getDb().prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as any;
  return row ? rowToRecord(row) : null;
}

export async function listRuns(limit = 30): Promise<DreamRunRecord[]> {
  const rows = getDb().prepare('SELECT * FROM dream_runs ORDER BY started_at DESC LIMIT ?').all(limit) as any[];
  return rows.map(rowToRecord);
}

export async function getLatestSuccessfulRun(trigger?: DreamTrigger): Promise<DreamRunRecord | null> {
  let sql = "SELECT * FROM dream_runs WHERE status = 'completed'";
  const params: unknown[] = [];
  if (trigger) { sql += ' AND trigger_kind = ?'; params.push(trigger); }
  sql += ' ORDER BY completed_at DESC LIMIT 1';
  const row = getDb().prepare(sql).get(...params) as any;
  return row ? rowToRecord(row) : null;
}

export async function assertCanApply(id: string): Promise<DreamRunRecord> {
  const run = await getRun(id);
  if (!run) throw new Error(`Dream run ${id} not found`);
  if (run.applied_at) return run;
  if (run.superseded) throw new Error(`Dream run ${id} is superseded and cannot be applied`);
  if (run.status !== 'completed') throw new Error(`Dream run ${id} is not completed`);
  return run;
}

export async function assertCanApplyGoals(id: string): Promise<DreamRunRecord> {
  const run = await getRun(id);
  if (!run) throw new Error(`Dream run ${id} not found`);
  if (run.goals_applied_at) return run;
  if (run.superseded) throw new Error(`Dream run ${id} is superseded and cannot apply goal changes`);
  if (run.status !== 'completed') throw new Error(`Dream run ${id} is not completed`);
  return run;
}

export async function markApplied(id: string): Promise<DreamRunRecord> {
  const run = await assertCanApply(id);
  if (run.applied_at) return run;
  const ts = new Date().toISOString();
  getDb().prepare('UPDATE dream_runs SET applied_at = ? WHERE id = ?').run(ts, id);
  const row = getDb().prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as any;
  if (!row) throw new Error(`Dream run not found: ${id}`);
  return rowToRecord(row);
}

export async function markGoalsApplied(id: string): Promise<DreamRunRecord> {
  const run = await assertCanApplyGoals(id);
  if (run.goals_applied_at) return run;
  const ts = new Date().toISOString();
  getDb().prepare('UPDATE dream_runs SET goals_applied_at = ? WHERE id = ?').run(ts, id);
  const row = getDb().prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as any;
  if (!row) throw new Error(`Dream run not found: ${id}`);
  return rowToRecord(row);
}

/**
 * Mark dream_runs that have been status='running' for longer than
 * `staleAfterMs` as failed. The pre-fix `startDreaming()` shape leaked an
 * orphan placeholder row whenever the manual-dream button fired (its real
 * sibling row would complete instead). After the fix the leak is gone,
 * but old orphans persist in the DB across deploys until something
 * actively cleans them up — that's this function.
 *
 * Returns the number of rows transitioned to 'failed'.
 *
 * Called once at plugin start (and re-runnable from tests).
 */
export async function sweepStaleRunningDreams(staleAfterMs = 5 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const info = getDb().prepare(`
    UPDATE dream_runs
       SET status = 'failed',
           completed_at = ?,
           error_message = COALESCE(error_message,
             'Marked failed by sweepStaleRunningDreams: row stuck in running for >' || ? || 'ms (likely an orphan from a deploy or plugin restart)')
     WHERE status = 'running'
       AND started_at < ?
  `).run(new Date().toISOString(), staleAfterMs, cutoff);
  return info.changes;
}

/**
 * Drop the cached SQLite handle. Test-only — allows the next call to
 * resolve a fresh DB path after OPENCLAW_HOME has been swapped to a
 * tmpdir. Pairs with db.resetDbForTests / raw-db.resetRawDbForTests.
 */
export function resetStoreForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
    _db = null;
  }
}

export async function prune(keepCount = 30): Promise<DreamRunRecord[]> {
  const rows = getDb().prepare('SELECT * FROM dream_runs ORDER BY started_at DESC, id DESC').all() as any[];
  const keep = rows.slice(0, keepCount);
  const remove = rows.slice(keepCount);

  if (remove.length > 0) {
    const deleteStmt = getDb().prepare('DELETE FROM dream_runs WHERE id = ?');
    const tx = getDb().transaction((ids: string[]) => {
      for (const runId of ids) deleteStmt.run(runId);
    });
    tx(remove.map((row: any) => row.id));
  }

  return keep.map(rowToRecord);
}
