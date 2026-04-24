/**
 * Tests for v3 personal_signals table — short-lived observations awaiting
 * consolidation. Compatible with device-side MobileSyncItem schema.
 * See docs/plans/memory-architecture.mdx §三 (personal_signals).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  expireElapsedPersonalSignals,
  getPersonalSignal,
  ingestPersonalSignals,
  listPersonalSignals,
  markPersonalSignalsConsumed,
  markPersonalSignalsReferenced,
  resetDbForTests,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-psignals-'));
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

test('ingestPersonalSignals: inserts batch with status=open', async () => {
  await withTempHome(async () => {
    const r = await ingestPersonalSignals([
      {
        kind: 'attention_item',
        title: 'Mom sent you a message',
        summary: 'asking about dinner',
        salience: 0.8,
        deviceId: 'dev-1',
      },
    ]);
    assert.equal(r.accepted, 1);
    assert.equal(r.inserted, 1);
    assert.equal(r.ignored, 0);
    assert.equal(r.ids.length, 1);
    const row = await getPersonalSignal(r.ids[0]!);
    assert.equal(row!.status, 'open');
    assert.equal(row!.salience, 0.8);
    assert.equal(row!.device_id, 'dev-1');
    assert.equal(row!.source, 'device');                 // default
  });
});

test('ingestPersonalSignals: dedupe_key uniqueness blocks duplicates', async () => {
  await withTempHome(async () => {
    const first = await ingestPersonalSignals([
      { kind: 'moment', title: 't', summary: 's', dedupeKey: 'k:1' },
    ]);
    assert.equal(first.inserted, 1);
    const second = await ingestPersonalSignals([
      { kind: 'moment', title: 't2', summary: 's2', dedupeKey: 'k:1' },
    ]);
    assert.equal(second.inserted, 0);
    assert.equal(second.ignored, 1);
    const all = await listPersonalSignals();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.title, 't');                    // first one wins
  });
});

test('ingestPersonalSignals: skips items missing required fields', async () => {
  await withTempHome(async () => {
    const r = await ingestPersonalSignals([
      { kind: '', title: 't', summary: 's' },           // missing kind
      { kind: 'k', title: '', summary: 's' },           // missing title
      { kind: 'k', title: 't', summary: '' },           // missing summary
      { kind: 'k', title: 't', summary: 's' },           // valid
    ]);
    assert.equal(r.accepted, 1);
    assert.equal(r.inserted, 1);
  });
});

test('listPersonalSignals: filters by kind / source / device / time', async () => {
  await withTempHome(async () => {
    await ingestPersonalSignals([
      { kind: 'moment', title: 'a', summary: 'a', deviceId: 'dev-1', source: 'device', occurredAt: '2026-04-23T08:00:00Z' },
      { kind: 'moment', title: 'b', summary: 'b', deviceId: 'dev-2', source: 'device', occurredAt: '2026-04-23T09:00:00Z' },
      { kind: 'attention_item', title: 'c', summary: 'c', source: 'evolution:digest', occurredAt: '2026-04-23T10:00:00Z' },
    ]);
    const moments = await listPersonalSignals({ kind: 'moment' });
    assert.equal(moments.length, 2);
    const dev1 = await listPersonalSignals({ deviceId: 'dev-1' });
    assert.equal(dev1.length, 1);
    const evolution = await listPersonalSignals({ source: 'evolution:digest' });
    assert.equal(evolution.length, 1);
    const recent = await listPersonalSignals({ since: '2026-04-23T08:30:00Z' });
    assert.equal(recent.length, 2);                     // b + c
  });
});

test('listPersonalSignals: minSalience filters low-importance items', async () => {
  await withTempHome(async () => {
    await ingestPersonalSignals([
      { kind: 'm', title: 'low', summary: 'l', salience: 0.2 },
      { kind: 'm', title: 'mid', summary: 'm', salience: 0.5 },
      { kind: 'm', title: 'high', summary: 'h', salience: 0.9 },
    ]);
    const r = await listPersonalSignals({ minSalience: 0.5 });
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((s) => s.title).sort(), ['high', 'mid']);
  });
});

test('markPersonalSignalsConsumed: open → consumed, others skipped', async () => {
  await withTempHome(async () => {
    const r = await ingestPersonalSignals([
      { kind: 'm', title: 'a', summary: 'a' },
      { kind: 'm', title: 'b', summary: 'b' },
    ]);
    const consumed = await markPersonalSignalsConsumed(r.ids, 'evol-run-1');
    assert.equal(consumed, 2);
    const after = await listPersonalSignals({ status: 'open' });
    assert.equal(after.length, 0);
    const consumedRows = await listPersonalSignals({ status: 'consumed' });
    assert.equal(consumedRows.length, 2);
    consumedRows.forEach((row) => assert.equal(row.consumed_by_run_id, 'evol-run-1'));

    // Idempotent: re-mark consumed → no further updates
    const reconsumed = await markPersonalSignalsConsumed(r.ids, 'evol-run-2');
    assert.equal(reconsumed, 0);
  });
});

test('expireElapsedPersonalSignals: archives rows whose expires_at has passed', async () => {
  await withTempHome(async () => {
    await ingestPersonalSignals([
      { kind: 'm', title: 'old', summary: 'o', expiresAt: '2025-01-01T00:00:00Z' },
      { kind: 'm', title: 'new', summary: 'n', expiresAt: '2099-01-01T00:00:00Z' },
    ]);
    const archived = await expireElapsedPersonalSignals();
    assert.equal(archived, 1);
    const open = await listPersonalSignals({ status: 'open' });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.title, 'new');
  });
});

test('markPersonalSignalsReferenced: bumps + dedupes + caps at 10', async () => {
  await withTempHome(async () => {
    const r = await ingestPersonalSignals([{ kind: 'm', title: 't', summary: 's' }]);
    const id = r.ids[0]!;
    await markPersonalSignalsReferenced([id], 'run-1');
    await markPersonalSignalsReferenced([id], 'run-1');
    await markPersonalSignalsReferenced([id], 'run-2');
    const row = await getPersonalSignal(id);
    assert.equal(row!.reference_count, 3);
    assert.deepEqual(row!.referenced_by_runs, ['run-1', 'run-2']);

    for (let i = 3; i <= 15; i++) {
      await markPersonalSignalsReferenced([id], `run-${i}`);
    }
    const after = await getPersonalSignal(id);
    assert.equal(after!.referenced_by_runs.length, 10);
  });
});

test('ingestPersonalSignals: TTL defaults to +30 days when expiresAt is omitted', async () => {
  await withTempHome(async () => {
    const r = await ingestPersonalSignals([
      { kind: 'm', title: 't', summary: 's', occurredAt: '2026-04-23T08:00:00Z' },
    ]);
    const row = await getPersonalSignal(r.ids[0]!);
    assert.ok(row!.expires_at);
    const expiry = new Date(row!.expires_at!).getTime();
    const occurred = new Date(row!.occurred_at).getTime();
    const diffDays = (expiry - occurred) / 86400000;
    assert.equal(Math.round(diffDays), 30);
  });
});

test('ingestPersonalSignals: explicit expiresAt=null overrides default TTL', async () => {
  await withTempHome(async () => {
    const r = await ingestPersonalSignals([
      { kind: 'm', title: 't', summary: 's', expiresAt: null },
    ]);
    const row = await getPersonalSignal(r.ids[0]!);
    assert.equal(row!.expires_at, null);
  });
});
