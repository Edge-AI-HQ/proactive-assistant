/**
 * Phase 2d — dream_runs folded into evolution_runs.details_json.
 *
 * dream_runs was the standalone dreaming-subsystem store. After Phase 2d
 * the dream payload (journal_markdown, candidates, profile_delta, ...)
 * lives in the unified evolution_runs row's details_json column. Same
 * row id; one ledger.
 *
 * This file pins down the migration + the new round-trip behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

import {
  getEvolutionRun,
  listEvolutionRuns,
  setEvolutionRunDetails,
  createEvolutionRun,
  resetDbForTests,
} from './db.ts';
import { createRun, completeRun, getRun, listRuns, markApplied, markGoalsApplied } from './dreaming/store.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-phase2d-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function seedLegacyDreamRuns(rows: Array<{
  id: string; trigger_kind: 'auto' | 'manual'; status: 'completed' | 'failed' | 'running';
  window_start: string; window_end: string; started_at: string; completed_at?: string | null;
  source_stats?: Record<string, unknown>; summary?: Record<string, unknown>;
  profile_delta?: Record<string, unknown>; goal_delta?: Record<string, unknown>;
  journal_markdown?: string | null; candidates?: Array<Record<string, unknown>>;
  applied_at?: string | null; goals_applied_at?: string | null;
  error_message?: string | null;
}>): void {
  const home = process.env.OPENCLAW_HOME!;
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'proactive.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_runs (
      id TEXT PRIMARY KEY,
      trigger_kind TEXT NOT NULL,
      status TEXT NOT NULL,
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
  `);
  const insert = db.prepare(
    `INSERT INTO dream_runs
       (id, trigger_kind, status, window_start, window_end, started_at, completed_at,
        source_stats, summary, profile_delta, goal_delta, journal_markdown, candidates,
        applied_at, goals_applied_at, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      r.id, r.trigger_kind, r.status, r.window_start, r.window_end, r.started_at, r.completed_at ?? null,
      r.source_stats ? JSON.stringify(r.source_stats) : null,
      r.summary ? JSON.stringify(r.summary) : null,
      r.profile_delta ? JSON.stringify(r.profile_delta) : null,
      r.goal_delta ? JSON.stringify(r.goal_delta) : null,
      r.journal_markdown ?? null,
      r.candidates ? JSON.stringify(r.candidates) : null,
      r.applied_at ?? null, r.goals_applied_at ?? null, r.error_message ?? null,
    );
  }
  db.close();
}

function legacyTableExists(): boolean {
  const home = process.env.OPENCLAW_HOME!;
  const dbPath = path.join(home, 'data', 'proactive.db');
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = 'dream_runs'",
  ).get();
  db.close();
  return !!row;
}

// ── 1. Backfill ──────────────────────────────────────────────────────────

test('migrateDreamRunsToEvolutionRuns: legacy rows surface as evolution_runs with details_json',
  withTempHome(async () => {
    seedLegacyDreamRuns([
      {
        id: 'dream_old_1', trigger_kind: 'auto', status: 'completed',
        window_start: '2026-04-22T00:00:00Z', window_end: '2026-04-23T00:00:00Z',
        started_at: '2026-04-23T06:00:00Z', completed_at: '2026-04-23T06:00:30Z',
        summary: { kind: 'updated', text: 'A normal day' },
        profile_delta: { facts: { before: {}, after: { x: 1 } } },
        goal_delta: { changes: [] },
        journal_markdown: '# Dream',
        candidates: [{ id: 'c1', title: 'foo' }],
        applied_at: '2026-04-23T06:00:31Z',
        goals_applied_at: '2026-04-23T06:00:32Z',
      },
    ]);

    const evolRows = await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 50 });
    assert.equal(evolRows.length, 1);
    const r = evolRows[0]!;
    assert.equal(r.status, 'completed');
    assert.equal(r.completed_at, '2026-04-23T06:00:30Z');
    assert.match(r.context_summary ?? '', /dream run dream_old_1/);

    const details = r.details as Record<string, any>;
    assert.equal(details.trigger, 'auto');
    assert.equal(details.summary.text, 'A normal day');
    assert.equal(details.journal_markdown, '# Dream');
    assert.equal(details.candidates[0].title, 'foo');
    assert.equal(details.applied_at, '2026-04-23T06:00:31Z');
    assert.equal(details.goals_applied_at, '2026-04-23T06:00:32Z');

    assert.equal(legacyTableExists(), false, 'dream_runs table dropped after backfill');
  }));

test('migrateDreamRunsToEvolutionRuns: no-op on a fresh install', withTempHome(async () => {
  const evolRows = await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 50 });
  assert.equal(evolRows.length, 0);
  assert.equal(legacyTableExists(), false);
}));

// ── 2. dreaming/store.ts now reads/writes evolution_runs ────────────────

test('dreaming/store.createRun + completeRun round-trips through evolution_runs',
  withTempHome(async () => {
    const created = await createRun({
      trigger: 'manual',
      windowStart: '2026-04-23T00:00:00Z',
      windowEnd: '2026-04-24T00:00:00Z',
    });
    assert.equal(created.trigger, 'manual');
    assert.equal(created.status, 'running');

    // The same id is the evolution_runs id (Phase 2d unified ledger).
    const evolMatch = await getEvolutionRun(created.id);
    assert.ok(evolMatch);
    assert.equal(evolMatch!.trigger_kind, 'daily_dream');
    assert.equal((evolMatch!.details as any).trigger, 'manual');

    await completeRun(created.id, {
      sourceStats: { gmail: { count: 3 } },
      summary: { kind: 'updated', text: 'sample', sourceCount: 1, candidateCount: 0 },
      profileDelta: { facts: { before: {}, after: { x: 1 } }, preferences: { before: {}, after: {} },
                      interests: { before: [], after: [] }, snapshots: { before: [], after: [] } },
      goalDelta: { changes: [] },
      journalMarkdown: '# Synthesis',
      candidates: [{ title: 'card-a' }],
    });

    const final = await getRun(created.id);
    assert.equal(final!.status, 'completed');
    assert.equal(final!.journal_markdown, '# Synthesis');
    assert.deepEqual(final!.candidates, [{ title: 'card-a' }]);

    // listRuns sees the dream too.
    const all = await listRuns(50);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, created.id);
  }));

test('markApplied + markGoalsApplied stamp into details_json',
  withTempHome(async () => {
    const created = await createRun({
      trigger: 'auto',
      windowStart: '2026-04-23T00:00:00Z',
      windowEnd: '2026-04-24T00:00:00Z',
    });
    await completeRun(created.id, {
      sourceStats: {},
      summary: { kind: 'updated', text: '', sourceCount: 0, candidateCount: 0 },
      profileDelta: { facts: { before: {}, after: {} }, preferences: { before: {}, after: {} },
                      interests: { before: [], after: [] }, snapshots: { before: [], after: [] } },
      goalDelta: { changes: [] },
      journalMarkdown: '',
      candidates: [],
    });

    await markApplied(created.id);
    await markGoalsApplied(created.id);

    const final = await getRun(created.id);
    assert.ok(final!.applied_at);
    assert.ok(final!.goals_applied_at);
  }));

// ── 3. setEvolutionRunDetails round-trip on any trigger_kind ─────────────

test('setEvolutionRunDetails persists arbitrary JSON on any evolution_run',
  withTempHome(async () => {
    const r = await createEvolutionRun({ triggerKind: 'manual', contextSummary: 'test' });
    await setEvolutionRunDetails(r.id, { hello: 'world', nested: { n: 1 } });
    const fresh = await getEvolutionRun(r.id);
    assert.deepEqual(fresh!.details, { hello: 'world', nested: { n: 1 } });
  }));
