/**
 * Phase 2b — profile_signals folded into personal_signals.
 *
 * The legacy SignalRow shape is preserved (CLI/route/dreaming callers
 * are untouched), but every read/write actually goes through
 * personal_signals. The legacy table is backfilled + dropped on first
 * schema init; subsequent boots see no legacy table and no-op.
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
  addSignal,
  listSignals,
  listPersonalSignals,
  resetDbForTests,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-phase2b-'));
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

function seedLegacyProfileSignals(rows: Array<{
  id: string; kind: string; target_type: string; target_key: string;
  value?: number | null; source?: string | null;
  context?: Record<string, unknown> | null; occurred_at: string;
}>): void {
  const home = process.env.OPENCLAW_HOME!;
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'proactive.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_signals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_key TEXT NOT NULL,
      value REAL,
      source TEXT,
      context TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    `INSERT INTO profile_signals (id, kind, target_type, target_key, value, source, context, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id, row.kind, row.target_type, row.target_key,
      row.value ?? null, row.source ?? null,
      row.context ? JSON.stringify(row.context) : null,
      row.occurred_at, row.occurred_at,
    );
  }
  db.close();
}

function legacyTableExists(): boolean {
  const home = process.env.OPENCLAW_HOME!;
  const dbPath = path.join(home, 'data', 'proactive.db');
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = 'profile_signals'",
  ).get();
  db.close();
  return !!row;
}

// ── 1. Backfill ──────────────────────────────────────────────────────────

test('migrateProfileSignalsToPersonalSignals: legacy rows surface in personal_signals + table dropped',
  withTempHome(async () => {
    seedLegacyProfileSignals([
      { id: 'sig-1', kind: 'view', target_type: 'topic', target_key: 'coffee', value: 0.7, source: 'manual', occurred_at: '2026-04-20T08:00:00Z' },
      { id: 'sig-2', kind: 'click', target_type: 'person', target_key: 'mom', value: 1, context: { msgId: 'm-99' }, occurred_at: '2026-04-21T08:00:00Z' },
    ]);

    // Trigger schema init via any v3 read.
    const personalRows = await listPersonalSignals({ kind: 'legacy_profile_signal', limit: 50 });
    assert.equal(personalRows.length, 2);
    const byId = new Map(personalRows.map((r) => [r.id, r]));

    const sig1 = byId.get('sig-1')!;
    assert.equal(sig1.subject, 'topic:coffee');
    assert.equal(sig1.salience, 0.7);
    assert.equal(sig1.source, 'manual');
    assert.equal((sig1.payload as Record<string, unknown>).legacy_kind, 'view');
    assert.equal((sig1.payload as Record<string, unknown>).target_type, 'topic');

    const sig2 = byId.get('sig-2')!;
    assert.equal(sig2.subject, 'person:mom');
    assert.deepEqual((sig2.payload as { context: Record<string, unknown> }).context, { msgId: 'm-99' });

    // Legacy listSignals projects them back into the v2 shape (no caller changes).
    const projected = await listSignals({ limit: 50 });
    assert.equal(projected.length, 2);
    const byKind = new Map(projected.map((s) => [s.id, s]));
    assert.equal(byKind.get('sig-1')!.kind, 'view');
    assert.equal(byKind.get('sig-1')!.target_type, 'topic');
    assert.equal(byKind.get('sig-1')!.target_key, 'coffee');

    assert.equal(legacyTableExists(), false);
  }));

test('migrateProfileSignalsToPersonalSignals: no-op on a fresh install',
  withTempHome(async () => {
    const rows = await listSignals({ limit: 50 });
    assert.equal(rows.length, 0);
    assert.equal(legacyTableExists(), false);
  }));

// ── 2. addSignal write-through ──────────────────────────────────────────

test('addSignal writes through to personal_signals + listSignals reads it back',
  withTempHome(async () => {
    const written = await addSignal({
      kind: 'view',
      targetType: 'topic',
      targetKey: 'coffee',
      value: 0.6,
      source: 'manual:test',
      context: { hint: 'morning' },
    });
    assert.equal(written.kind, 'view');
    assert.equal(written.target_type, 'topic');
    assert.equal(written.target_key, 'coffee');
    assert.equal(written.value, 0.6);

    // Lands in the v3 store.
    const v3 = await listPersonalSignals({ kind: 'legacy_profile_signal', limit: 50 });
    assert.equal(v3.length, 1);
    assert.equal(v3[0]!.subject, 'topic:coffee');
    assert.equal(v3[0]!.salience, 0.6);

    // listSignals projects the round-trip back to the legacy shape.
    const back = await listSignals({ limit: 50 });
    assert.equal(back.length, 1);
    assert.equal(back[0]!.kind, 'view');
    assert.equal(back[0]!.target_key, 'coffee');
    assert.deepEqual(back[0]!.context, { hint: 'morning' });
  }));
