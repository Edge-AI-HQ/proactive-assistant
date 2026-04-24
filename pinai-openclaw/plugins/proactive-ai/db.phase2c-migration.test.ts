/**
 * Phase 2c — profile_interests folded into memory{subject:'<kind>:<key>',
 *                                                  source:'extract:dream_interest'}.
 *
 * Two distinct things to verify:
 *   1. Backfill: pre-existing profile_interests rows surface as memory
 *      rows with the deterministic id and the v3 reference triple set;
 *      the legacy table is dropped after.
 *   2. upsertInterestAsMemory: write-through helper that the dream agent
 *      now uses. First call inserts, subsequent calls bump
 *      reference_count (no duplicate row).
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
  upsertInterestAsMemory,
  listInterests,
  getMemoryV3,
  listMemoryV3,
  resetDbForTests,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-phase2c-'));
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

/**
 * Pre-create the legacy profile_interests table + rows in the same
 * proactive.db file the helpers will open, so the schema init's
 * migrateProfileInterestsToMemory sees an existing legacy table to backfill.
 */
function seedLegacyProfileInterests(rows: Array<{
  kind: string; key: string; score: number; confidence: number;
  evidence_count: number; status?: string; last_signal_at?: string | null;
}>): void {
  const home = process.env.OPENCLAW_HOME!;
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'proactive.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_interests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_signal_at TEXT,
      UNIQUE(kind, key)
    );
  `);
  const insert = db.prepare(
    `INSERT INTO profile_interests (id, kind, key, score, confidence, evidence_count, status, last_signal_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      `legacy_${row.kind}_${row.key}`, row.kind, row.key,
      row.score, row.confidence, row.evidence_count,
      row.status ?? 'active', row.last_signal_at ?? null,
    );
  }
  db.close();
}

function legacyTableExists(): boolean {
  const home = process.env.OPENCLAW_HOME!;
  const dbPath = path.join(home, 'data', 'proactive.db');
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = 'profile_interests'",
  ).get();
  db.close();
  return !!row;
}

// ── 1. Backfill ──────────────────────────────────────────────────────────

test('migrateProfileInterestsToMemory: legacy rows become memory rows with the right shape',
  withTempHome(async () => {
    seedLegacyProfileInterests([
      { kind: 'topic', key: 'coffee', score: 0.85, confidence: 0.9, evidence_count: 5, last_signal_at: '2026-04-20T08:00:00Z' },
      { kind: 'topic', key: 'commute', score: 0.6, confidence: 0.7, evidence_count: 3, last_signal_at: '2026-04-19T08:00:00Z' },
      { kind: 'person', key: 'mom', score: 0.95, confidence: 1, evidence_count: 12 },
    ]);

    // Trigger schema init via any v3 read.
    const all = await listMemoryV3({ status: 'active', limit: 50 });
    const byId = new Map(all.map((m) => [m.id, m]));

    const coffee = byId.get('interest:topic:coffee');
    assert.ok(coffee, 'coffee row should exist as memory');
    assert.equal(coffee!.subject, 'topic:coffee');
    assert.equal(coffee!.source, 'extract:dream_interest');
    assert.equal(coffee!.quality, 0.85);
    assert.equal(coffee!.confidence, 0.9);
    assert.equal(coffee!.reference_count, 4, 'evidence_count - 1 (initial write counts as the first)');
    assert.deepEqual(coffee!.tags.sort(), ['interest', 'topic']);

    const mom = byId.get('interest:person:mom');
    assert.ok(mom);
    assert.equal(mom!.subject, 'person:mom');
    assert.equal(mom!.quality, 0.95);

    // Legacy table is gone.
    assert.equal(legacyTableExists(), false);
  }));

test('migrateProfileInterestsToMemory: no-op on a fresh install', withTempHome(async () => {
  const all = await listMemoryV3({ status: 'active', limit: 50 });
  assert.equal(all.length, 0);
  assert.equal(legacyTableExists(), false);
}));

// ── 2. upsertInterestAsMemory write-through ─────────────────────────────

test('upsertInterestAsMemory: first call inserts a memory with deterministic id',
  withTempHome(async () => {
    const m = await upsertInterestAsMemory({
      kind: 'topic', key: 'coffee', score: 0.7, confidence: 0.8,
      sourceRunId: 'run_abc',
    });
    assert.equal(m.id, 'interest:topic:coffee');
    assert.equal(m.subject, 'topic:coffee');
    assert.equal(m.quality, 0.7);
    assert.equal(m.confidence, 0.8);
    assert.equal(m.source, 'extract:dream_interest');
    assert.equal(m.source_run_id, 'run_abc');
    assert.equal(m.reference_count, 0);

    // The deterministic id makes lookups easy.
    const fetched = await getMemoryV3('interest:topic:coffee');
    assert.ok(fetched);
  }));

test('upsertInterestAsMemory: re-mention bumps reference_count + refreshes quality, no duplicate row',
  withTempHome(async () => {
    await upsertInterestAsMemory({ kind: 'topic', key: 'coffee', score: 0.5, confidence: 0.6, sourceRunId: 'run_1' });
    await upsertInterestAsMemory({ kind: 'topic', key: 'coffee', score: 0.9, confidence: 0.95, sourceRunId: 'run_2' });
    await upsertInterestAsMemory({ kind: 'topic', key: 'coffee', score: 0.85, confidence: 0.92, sourceRunId: 'run_3' });

    const all = await listMemoryV3({ status: 'active', limit: 50 });
    const matching = all.filter((m) => m.id === 'interest:topic:coffee');
    assert.equal(matching.length, 1, 'idempotent on (kind, key) — no duplicate rows');

    const m = matching[0]!;
    assert.equal(m.reference_count, 2, 'two re-mentions -> two bumps');
    assert.equal(m.quality, 0.85, 'latest score wins');
    assert.equal(m.confidence, 0.92);
    assert.equal(m.source_run_id, 'run_3', 'attribution updates to latest dream');
    assert.ok(m.last_referenced_at, 'last_referenced_at stamped on bump');
  }));

// ── 3. listInterests projection over the v3 memory table ─────────────────

test('listInterests projects v3 memory rows back into the legacy InterestRow shape',
  withTempHome(async () => {
    await upsertInterestAsMemory({ kind: 'topic', key: 'coffee', score: 0.85, confidence: 0.9 });
    await upsertInterestAsMemory({ kind: 'topic', key: 'commute', score: 0.5, confidence: 0.7 });
    await upsertInterestAsMemory({ kind: 'person', key: 'mom', score: 0.95, confidence: 1 });

    const all = await listInterests({ limit: 50 });
    assert.equal(all.length, 3);
    // Default ordering is quality DESC.
    assert.equal(all[0]!.key, 'mom');
    assert.equal(all[0]!.kind, 'person');
    assert.equal(all[0]!.score, 0.95);

    // kind filter narrows to just topic:* via subjectPrefix.
    const topics = await listInterests({ kind: 'topic', limit: 50 });
    assert.equal(topics.length, 2);
    assert.deepEqual(topics.map((i) => i.key).sort(), ['coffee', 'commute']);
  }));
