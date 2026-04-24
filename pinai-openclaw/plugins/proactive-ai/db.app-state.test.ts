/**
 * Tests for app_state KV table — replaces the per-domain single-row
 * state tables (auto_loop_state, chat_crystallize_state, ingest_cursor).
 * See docs/plans/memory-architecture.mdx §三 (app_state).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  deleteAppState,
  getAppState,
  listAppState,
  resetDbForTests,
  setAppState,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-app-state-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('app_state: get returns null when key absent', async () => {
  await withTempHome(async () => {
    const v = await getAppState<string>('scheduler', 'last_finished_at');
    assert.equal(v, null);
  });
});

test('app_state: set then get round-trips JSON-able values', async () => {
  await withTempHome(async () => {
    await setAppState('cursor', 'gmail', '2026-04-23T08:00:00Z');
    const v = await getAppState<string>('cursor', 'gmail');
    assert.equal(v, '2026-04-23T08:00:00Z');

    await setAppState('scheduler', 'auto_loop', { last_started_at: '2026-04-23T07:00:00Z', last_status: 'completed' });
    const obj = await getAppState<{ last_started_at: string; last_status: string }>('scheduler', 'auto_loop');
    assert.deepEqual(obj, { last_started_at: '2026-04-23T07:00:00Z', last_status: 'completed' });
  });
});

test('app_state: set is idempotent — repeated set updates value', async () => {
  await withTempHome(async () => {
    await setAppState('scheduler', 'k', 1);
    await setAppState('scheduler', 'k', 2);
    await setAppState('scheduler', 'k', 3);
    const v = await getAppState<number>('scheduler', 'k');
    assert.equal(v, 3);
  });
});

test('app_state: namespaces isolate keys with same name', async () => {
  await withTempHome(async () => {
    await setAppState('cursor', 'last_seen', 'A');
    await setAppState('crystallize', 'last_seen', 'B');
    assert.equal(await getAppState<string>('cursor', 'last_seen'), 'A');
    assert.equal(await getAppState<string>('crystallize', 'last_seen'), 'B');
  });
});

test('app_state: delete removes only the targeted key', async () => {
  await withTempHome(async () => {
    await setAppState('scheduler', 'a', 1);
    await setAppState('scheduler', 'b', 2);
    await deleteAppState('scheduler', 'a');
    assert.equal(await getAppState<number>('scheduler', 'a'), null);
    assert.equal(await getAppState<number>('scheduler', 'b'), 2);
  });
});

test('app_state: list returns all keys in a namespace, ordered by key', async () => {
  await withTempHome(async () => {
    await setAppState('cursor', 'gmail', 'A');
    await setAppState('cursor', 'calendar', 'B');
    await setAppState('cursor', 'notion', 'C');
    await setAppState('other', 'gmail', 'X');

    const rows = await listAppState<string>('cursor');
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.key, r.value]),
      [
        ['calendar', 'B'],
        ['gmail', 'A'],
        ['notion', 'C'],
      ],
    );
  });
});

test('app_state: handles null value', async () => {
  await withTempHome(async () => {
    await setAppState('scheduler', 'k', null);
    assert.equal(await getAppState<unknown>('scheduler', 'k'), null);
  });
});

test('app_state: deleting a missing key is a no-op', async () => {
  await withTempHome(async () => {
    await deleteAppState('scheduler', 'never-set');
    // No throw, no side effect.
    assert.deepEqual(await listAppState('scheduler'), []);
  });
});
