/**
 * Phase 15: collapse single-row tables (auto_loop_state +
 * chat_crystallize_state) into the app_state KV.
 *
 * Two distinct things to verify:
 *   1. Backfill: a pre-existing row in the legacy table moves into the
 *      KV with the same values, and the legacy table is gone afterwards.
 *   2. KV-backed helpers: getAutoLoopState / saveAutoLoopState /
 *      getCrystallizeState / bumpCrystallizeTurn / markCrystallized
 *      behave end-to-end against app_state without the legacy table
 *      ever existing.
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
  getAutoLoopState,
  saveAutoLoopState,
  getCrystallizeState,
  bumpCrystallizeTurn,
  markCrystallized,
  getAppState,
  resetDbForTests,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-phase15-'));
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
 * Pre-create the legacy auto_loop_state table + a row INSIDE the same
 * proactive.db file the helpers will open — so when the schema init runs
 * (via getAutoLoopState() below), migrateAutoLoopStateToAppState sees an
 * existing legacy table to backfill.
 */
function seedLegacyTablesBeforeSchemaInit(autoLoopRow: {
  last_started_at: string | null; last_finished_at: string | null;
  last_status: string | null; updated_at: string;
} | null, crystallizeRow: {
  turn_count: number; last_crystallized_at: string | null;
  last_session_key: string | null; last_message_at: string | null;
  updated_at: string;
} | null): void {
  const home = process.env.OPENCLAW_HOME!;
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'proactive.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_loop_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_started_at TEXT,
      last_finished_at TEXT,
      last_status TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_crystallize_state (
      id TEXT PRIMARY KEY DEFAULT 'default',
      turn_count INTEGER NOT NULL DEFAULT 0,
      last_crystallized_at TEXT,
      last_session_key TEXT,
      last_message_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  if (autoLoopRow) {
    db.prepare(
      'INSERT INTO auto_loop_state (id, last_started_at, last_finished_at, last_status, updated_at) VALUES (1, ?, ?, ?, ?)',
    ).run(autoLoopRow.last_started_at, autoLoopRow.last_finished_at, autoLoopRow.last_status, autoLoopRow.updated_at);
  }
  if (crystallizeRow) {
    db.prepare(
      `INSERT INTO chat_crystallize_state
        (id, turn_count, last_crystallized_at, last_session_key, last_message_at, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?)`,
    ).run(
      crystallizeRow.turn_count, crystallizeRow.last_crystallized_at,
      crystallizeRow.last_session_key, crystallizeRow.last_message_at,
      crystallizeRow.updated_at,
    );
  }
  db.close();
}

function legacyTableExists(name: 'auto_loop_state' | 'chat_crystallize_state'): boolean {
  const home = process.env.OPENCLAW_HOME!;
  const dbPath = path.join(home, 'data', 'proactive.db');
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
  ).get(name) as { name: string } | undefined;
  db.close();
  return !!row;
}

// ── 1. Backfill: legacy auto_loop_state row migrates to app_state ─────

test('migrateAutoLoopStateToAppState: backfills an existing row + drops the table',
  withTempHome(async () => {
    seedLegacyTablesBeforeSchemaInit(
      {
        last_started_at: '2026-04-23T08:00:00.000Z',
        last_finished_at: '2026-04-23T08:01:00.000Z',
        last_status: 'completed',
        updated_at: '2026-04-23T08:01:00.000Z',
      },
      null,
    );

    // Trigger schema init (which runs the migration).
    const state = await getAutoLoopState();

    assert.equal(state.last_started_at, '2026-04-23T08:00:00.000Z');
    assert.equal(state.last_finished_at, '2026-04-23T08:01:00.000Z');
    assert.equal(state.last_status, 'completed');

    // The KV row exists with the same shape.
    const kv = await getAppState<{ last_started_at: string }>('scheduler', 'autoLoopState');
    assert.ok(kv);
    assert.equal(kv!.last_started_at, '2026-04-23T08:00:00.000Z');

    // The legacy table is gone.
    assert.equal(legacyTableExists('auto_loop_state'), false);
  }));

test('migrateAutoLoopStateToAppState: no-op on a fresh install (no legacy table)',
  withTempHome(async () => {
    const state = await getAutoLoopState();
    assert.equal(state.last_started_at, null);
    assert.equal(legacyTableExists('auto_loop_state'), false,
      'fresh install: table never created at all');
  }));

// ── 2. Backfill: legacy chat_crystallize_state row migrates ──────────

test('migrateCrystallizeStateToAppState: backfills an existing row + drops the table',
  withTempHome(async () => {
    seedLegacyTablesBeforeSchemaInit(null, {
      turn_count: 7,
      last_crystallized_at: '2026-04-22T10:00:00.000Z',
      last_session_key: 'agent:main:proactive-ai:chat:abc',
      last_message_at: '2026-04-22T11:00:00.000Z',
      updated_at: '2026-04-22T11:00:00.000Z',
    });

    const state = await getCrystallizeState();
    assert.equal(state.turn_count, 7);
    assert.equal(state.last_session_key, 'agent:main:proactive-ai:chat:abc');
    assert.equal(state.last_crystallized_at, '2026-04-22T10:00:00.000Z');

    assert.equal(legacyTableExists('chat_crystallize_state'), false);

    const kv = await getAppState<{ turn_count: number }>('crystallize', 'state');
    assert.equal(kv!.turn_count, 7);
  }));

// ── 3. KV-backed helpers behave correctly end-to-end ─────────────────

test('saveAutoLoopState: round-trips via app_state KV', withTempHome(async () => {
  await saveAutoLoopState({ last_started_at: '2026-04-24T01:00:00.000Z', last_status: 'running' });
  const after = await getAutoLoopState();
  assert.equal(after.last_started_at, '2026-04-24T01:00:00.000Z');
  assert.equal(after.last_status, 'running');
  assert.equal(after.last_finished_at, null);

  await saveAutoLoopState({ last_finished_at: '2026-04-24T01:00:30.000Z', last_status: 'completed' });
  const final = await getAutoLoopState();
  assert.equal(final.last_started_at, '2026-04-24T01:00:00.000Z',
    'unspecified fields preserved across writes');
  assert.equal(final.last_finished_at, '2026-04-24T01:00:30.000Z');
  assert.equal(final.last_status, 'completed');
}));

test('bumpCrystallizeTurn + markCrystallized round-trip via app_state KV',
  withTempHome(async () => {
    let s = await getCrystallizeState();
    assert.equal(s.turn_count, 0);

    await bumpCrystallizeTurn('agent:main:proactive-ai:chat:s1');
    await bumpCrystallizeTurn('agent:main:proactive-ai:chat:s2');
    await bumpCrystallizeTurn('agent:main:proactive-ai:chat:card:c3');

    s = await getCrystallizeState();
    assert.equal(s.turn_count, 3);
    assert.equal(s.last_session_key, 'agent:main:proactive-ai:chat:card:c3',
      'most recent bumper wins');

    await markCrystallized();
    s = await getCrystallizeState();
    assert.equal(s.turn_count, 0, 'markCrystallized resets the counter');
    assert.ok(s.last_crystallized_at, 'and stamps last_crystallized_at');
    assert.equal(s.last_session_key, 'agent:main:proactive-ai:chat:card:c3',
      'session-key memory is preserved across reset');
  }));
