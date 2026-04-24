/**
 * Tests for the connector-sync enqueuer.
 *
 * Covers the gates documented in the module header:
 *   - empty Composio response → no-op
 *   - ACTIVE accounts WITH succeeded init AND no/stale cursor → enqueued
 *   - ACTIVE accounts WITHOUT succeeded init → awaitingInit (skipped)
 *   - ACTIVE accounts WITH cursor.last_synced_at >= windowStart → alreadyHandled
 *   - intervalMsOverride controls window size
 *   - Composio fetch failure → failed=true, no side effects
 *   - second sweep in same window is idempotent (key collision)
 *   - malformed accounts (missing fields) counted as invalid
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  enqueueBackgroundTask,
  getBackgroundTaskByIdempotencyKey,
  listBackgroundTasks,
  upsertConnectorSyncCursor,
  resetDbForTests,
} from '../db.ts';
import { BackgroundTaskScheduler } from './scheduler.ts';
import { enqueueDueConnectorSyncs } from './connector-sync-enqueuer.ts';
import type { TaskHandler } from './scheduler.ts';
import type { ComposioFetcher } from './handlers/connector-init.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-sync-enq-'));
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

function staticFetcher(items: any[]): ComposioFetcher {
  return async (_path) => ({ items });
}

/**
 * Set up "connector.init for (toolkit, accountId) is succeeded" state by
 * enqueueing + ticking the scheduler with a stub init handler that returns
 * success immediately. Production sets this state by actually running init;
 * tests skip the work.
 */
async function plantSucceededInit(toolkit: string, accountId: string): Promise<void> {
  await enqueueBackgroundTask({
    type: 'connector.init',
    idempotencyKey: `connector.init:${toolkit}:${accountId}:v1`,
    payload: { toolkit, connectedAccountId: accountId },
  });
  const stub: TaskHandler = async () => ({ status: 'succeeded', result: { stub: true } });
  const sched = new BackgroundTaskScheduler({ workerId: 'plant', leaseDurationMs: 60_000 });
  sched.registerHandler('connector.init', stub);
  await sched.tick();
}

// ──────────────────────────────────────────────────────────────────────
// Empty / fetch-failure paths
// ──────────────────────────────────────────────────────────────────────

test('no ACTIVE accounts → empty report, no tasks enqueued', async () => {
  await withTempHome(async () => {
    const r = await enqueueDueConnectorSyncs({
      userId: 'u', fetcher: staticFetcher([]),
    });
    assert.equal(r.scanned, 0);
    assert.equal(r.enqueued, 0);
    assert.equal(r.failed, false);
  });
});

test('Composio fetcher throws → failed=true, no enqueue', async () => {
  await withTempHome(async () => {
    const fetcher: ComposioFetcher = async () => { throw new Error('Composio 503'); };
    const r = await enqueueDueConnectorSyncs({ userId: 'u', fetcher });
    assert.equal(r.failed, true);
    assert.match(r.failedReason ?? '', /503/);
    const tasks = await listBackgroundTasks({ type: 'connector.sync' });
    assert.equal(tasks.length, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Init gate
// ──────────────────────────────────────────────────────────────────────

test('ACTIVE account WITHOUT succeeded init → awaitingInit (no sync enqueued)', async () => {
  await withTempHome(async () => {
    // Enqueue init but DON'T run it (status stays 'queued')
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:gmail:acc-no-init:v1',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-no-init' },
    });
    const r = await enqueueDueConnectorSyncs({
      userId: 'u',
      fetcher: staticFetcher([
        { id: 'acc-no-init', toolkit: { slug: 'gmail' } },
      ]),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.awaitingInit, 1);
    assert.equal(r.enqueued, 0);
    const tasks = await listBackgroundTasks({ type: 'connector.sync' });
    assert.equal(tasks.length, 0);
  });
});

test('ACTIVE account with NO init row at all → awaitingInit', async () => {
  await withTempHome(async () => {
    const r = await enqueueDueConnectorSyncs({
      userId: 'u',
      fetcher: staticFetcher([{ id: 'acc-orphan', toolkit: { slug: 'slack' } }]),
    });
    assert.equal(r.awaitingInit, 1);
    assert.equal(r.enqueued, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Window gate (cursor)
// ──────────────────────────────────────────────────────────────────────

test('init succeeded + no cursor → enqueued (bootstrap path)', async () => {
  await withTempHome(async () => {
    await plantSucceededInit('gmail', 'acc-1');
    const r = await enqueueDueConnectorSyncs({
      userId: 'u',
      fetcher: staticFetcher([{ id: 'acc-1', toolkit: { slug: 'gmail' } }]),
    });
    assert.equal(r.scanned, 1);
    assert.equal(r.awaitingInit, 0);
    assert.equal(r.enqueued, 1);

    const created = await listBackgroundTasks({ type: 'connector.sync' });
    assert.equal(created.length, 1);
    assert.match(created[0]!.idempotency_key, /^connector\.sync:gmail:acc-1:\d+$/);
    assert.equal(created[0]!.payload.toolkit, 'gmail');
    assert.equal(created[0]!.payload.connectedAccountId, 'acc-1');
    assert.equal(created[0]!.payload.reason, 'enqueuer');
    assert.equal(created[0]!.max_attempts, 2);
  });
});

test('cursor INSIDE current window → alreadyHandled (no enqueue)', async () => {
  await withTempHome(async () => {
    await plantSucceededInit('gmail', 'acc-1');
    // Cursor planted at "now" — clearly inside the current window
    await upsertConnectorSyncCursor({
      toolkit: 'gmail', connectedAccountId: 'acc-1',
      lastSyncedAt: new Date().toISOString(),
    });
    const r = await enqueueDueConnectorSyncs({
      userId: 'u',
      fetcher: staticFetcher([{ id: 'acc-1', toolkit: { slug: 'gmail' } }]),
    });
    assert.equal(r.alreadyHandled, 1);
    assert.equal(r.enqueued, 0);
    assert.equal(
      (await listBackgroundTasks({ type: 'connector.sync' })).length,
      0,
    );
  });
});

test('cursor OLDER than current window → enqueued (re-sync due)', async () => {
  await withTempHome(async () => {
    await plantSucceededInit('gmail', 'acc-1');
    // intervalOverride = 1h, cursor 3h old → way past window
    await upsertConnectorSyncCursor({
      toolkit: 'gmail', connectedAccountId: 'acc-1',
      lastSyncedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    });
    const r = await enqueueDueConnectorSyncs({
      userId: 'u',
      intervalMsOverride: 3600_000,
      fetcher: staticFetcher([{ id: 'acc-1', toolkit: { slug: 'gmail' } }]),
    });
    assert.equal(r.enqueued, 1);
    assert.equal(r.alreadyHandled, 0);
  });
});

test('intervalMsOverride caps the window size; second sweep in same window is idempotent', async () => {
  await withTempHome(async () => {
    await plantSucceededInit('gmail', 'acc-1');
    const fetcher = staticFetcher([{ id: 'acc-1', toolkit: { slug: 'gmail' } }]);
    const r1 = await enqueueDueConnectorSyncs({
      userId: 'u', fetcher, intervalMsOverride: 12 * 3600_000, // 12h
    });
    assert.equal(r1.enqueued, 1);

    // Second sweep in same window: NO new task (idempotency key collision)
    const r2 = await enqueueDueConnectorSyncs({
      userId: 'u', fetcher, intervalMsOverride: 12 * 3600_000,
    });
    assert.equal(r2.enqueued, 0);
    assert.equal(r2.alreadyHandled, 1);

    const tasks = await listBackgroundTasks({ type: 'connector.sync' });
    assert.equal(tasks.length, 1, 'still exactly one connector.sync row');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Mixed accounts
// ──────────────────────────────────────────────────────────────────────

test('mixed accounts: init-done + init-pending + invalid → correct counts', async () => {
  await withTempHome(async () => {
    await plantSucceededInit('gmail', 'acc-ready');
    // Start an init for this account but leave it queued
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:slack:acc-pending:v1',
      payload: { toolkit: 'slack', connectedAccountId: 'acc-pending' },
    });

    const r = await enqueueDueConnectorSyncs({
      userId: 'u',
      fetcher: staticFetcher([
        { id: 'acc-ready', toolkit: { slug: 'gmail' } },        // → enqueued
        { id: 'acc-pending', toolkit: { slug: 'slack' } },      // → awaitingInit
        { id: '', toolkit: { slug: 'notion' } },                // → invalid (no id)
        { id: 'acc-no-toolkit', toolkit: { slug: '' } },        // → invalid (no toolkit)
      ]),
    });
    assert.equal(r.scanned, 4);
    assert.equal(r.enqueued, 1);
    assert.equal(r.awaitingInit, 1);
    assert.equal(r.invalid, 2);

    const created = await getBackgroundTaskByIdempotencyKey(
      (await listBackgroundTasks({ type: 'connector.sync' }))[0]!.idempotency_key,
    );
    assert.equal(created!.payload.connectedAccountId, 'acc-ready');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Window key collision proof
// ──────────────────────────────────────────────────────────────────────

test('idempotency key encodes windowStart so cross-window keys differ', async () => {
  await withTempHome(async () => {
    await plantSucceededInit('gmail', 'acc-1');

    // Fix "now" to known timestamps in two different windows
    const intervalMs = 12 * 3600_000;
    const t0 = new Date(intervalMs * 100); // window 100*12h
    const t1 = new Date(intervalMs * 101); // window 101*12h

    const fetcher = staticFetcher([{ id: 'acc-1', toolkit: { slug: 'gmail' } }]);
    const r0 = await enqueueDueConnectorSyncs({
      userId: 'u', fetcher, intervalMsOverride: intervalMs, now: t0,
    });
    assert.equal(r0.enqueued, 1);

    // Need to age the cursor past window 100 — sync handler would normally
    // do this; here we just stamp it manually so the next sweep can run.
    await upsertConnectorSyncCursor({
      toolkit: 'gmail', connectedAccountId: 'acc-1',
      lastSyncedAt: t0.toISOString(),
    });

    const r1 = await enqueueDueConnectorSyncs({
      userId: 'u', fetcher, intervalMsOverride: intervalMs, now: t1,
    });
    assert.equal(r1.enqueued, 1);

    const tasks = await listBackgroundTasks({ type: 'connector.sync' });
    assert.equal(tasks.length, 2);
    // The two keys differ in their window suffix
    const keys = tasks.map((t) => t.idempotency_key).sort();
    assert.equal(keys[0], `connector.sync:gmail:acc-1:${intervalMs * 100}`);
    assert.equal(keys[1], `connector.sync:gmail:acc-1:${intervalMs * 101}`);
  });
});
