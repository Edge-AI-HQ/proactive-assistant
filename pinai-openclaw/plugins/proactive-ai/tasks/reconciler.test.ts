/**
 * Tests for the connector init reconciler. Covers:
 *   - empty Composio response → no-op report
 *   - 3 ACTIVE connections → 3 enqueued, idempotent on second sweep
 *   - mixed: some new, some already in queue → only the new ones enqueued
 *   - malformed connection items (missing toolkit or id) → counted as invalid
 *   - Composio fetch failure → failed=true, no enqueue side effects
 *   - dedupe contract: same key twice never creates two rows
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
  resetDbForTests,
} from '../db.ts';
import { reconcileActiveConnectorAccounts } from './reconciler.ts';
import type { ComposioFetcher } from './handlers/connector-init.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-recon-'));
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

test('reconciler: no ACTIVE accounts → empty report', async () => {
  await withTempHome(async () => {
    const r = await reconcileActiveConnectorAccounts({
      fetcher: staticFetcher([]), userId: 'u',
    });
    assert.deepEqual(r, {
      scanned: 0, enqueued: 0, alreadyHandled: 0, invalid: 0, failed: false,
    });
  });
});

test('reconciler: 3 ACTIVE accounts → 3 connector.init tasks created', async () => {
  await withTempHome(async () => {
    const r = await reconcileActiveConnectorAccounts({
      userId: 'u',
      fetcher: staticFetcher([
        { id: 'acc-gmail', toolkit: { slug: 'gmail' } },
        { id: 'acc-gcal', toolkit: { slug: 'googlecalendar' } },
        { id: 'acc-slack', toolkit: { slug: 'slack' } },
      ]),
    });
    assert.equal(r.scanned, 3);
    assert.equal(r.enqueued, 3);
    assert.equal(r.alreadyHandled, 0);

    const tasks = await listBackgroundTasks({ type: 'connector.init', limit: 10 });
    assert.equal(tasks.length, 3);
    const keys = tasks.map((t) => t.idempotency_key).sort();
    assert.deepEqual(keys, [
      'connector.init:gmail:acc-gmail:v1',
      'connector.init:googlecalendar:acc-gcal:v1',
      'connector.init:slack:acc-slack:v1',
    ]);
    // Payload defaults are populated
    const sample = tasks.find((t) => t.idempotency_key.includes('gmail'))!;
    assert.equal(sample.payload.toolkit, 'gmail');
    assert.equal(sample.payload.connectedAccountId, 'acc-gmail');
    assert.equal(sample.payload.reason, 'reconciler');
    assert.ok(typeof sample.payload.limit === 'number');
  });
});

test('reconciler: idempotent — second sweep enqueues 0 even if accounts unchanged', async () => {
  await withTempHome(async () => {
    const fetcher = staticFetcher([
      { id: 'a1', toolkit: { slug: 'gmail' } },
      { id: 'a2', toolkit: { slug: 'googlecalendar' } },
    ]);
    const r1 = await reconcileActiveConnectorAccounts({ fetcher, userId: 'u' });
    assert.equal(r1.enqueued, 2);

    const r2 = await reconcileActiveConnectorAccounts({ fetcher, userId: 'u' });
    assert.equal(r2.scanned, 2);
    assert.equal(r2.enqueued, 0);
    assert.equal(r2.alreadyHandled, 2);

    // Still only 2 rows in the DB
    const tasks = await listBackgroundTasks({ type: 'connector.init' });
    assert.equal(tasks.length, 2);
  });
});

test('reconciler: mixed new + pre-existing → only the new are enqueued', async () => {
  await withTempHome(async () => {
    // Pre-stage one account that /composio/wait already handled
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:gmail:acc-existing:v1',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-existing' },
    });
    const r = await reconcileActiveConnectorAccounts({
      userId: 'u',
      fetcher: staticFetcher([
        { id: 'acc-existing', toolkit: { slug: 'gmail' } },
        { id: 'acc-new', toolkit: { slug: 'googlecalendar' } },
      ]),
    });
    assert.equal(r.scanned, 2);
    assert.equal(r.alreadyHandled, 1);
    assert.equal(r.enqueued, 1);
    // The new one shows up
    const created = await getBackgroundTaskByIdempotencyKey(
      'connector.init:googlecalendar:acc-new:v1',
    );
    assert.ok(created);
    assert.equal(created!.payload.connectedAccountId, 'acc-new');
  });
});

test('reconciler: malformed items (missing toolkit or id) counted as invalid', async () => {
  await withTempHome(async () => {
    const r = await reconcileActiveConnectorAccounts({
      userId: 'u',
      fetcher: staticFetcher([
        { id: 'good', toolkit: { slug: 'gmail' } },
        { /* no id */ toolkit: { slug: 'gmail' } },
        { id: 'no-toolkit' /* no toolkit */ },
        { id: '', toolkit: { slug: 'slack' } },  // empty id
      ]),
    });
    assert.equal(r.scanned, 4);
    assert.equal(r.enqueued, 1);
    assert.equal(r.invalid, 3);
  });
});

test('reconciler: Composio fetch failure → failed=true, no DB writes', async () => {
  await withTempHome(async () => {
    const fetcher: ComposioFetcher = async () => { throw new Error('Composio 503: down'); };
    const r = await reconcileActiveConnectorAccounts({ fetcher, userId: 'u' });
    assert.equal(r.failed, true);
    assert.match(r.failedReason ?? '', /503/);
    assert.equal(r.enqueued, 0);
    assert.equal(r.scanned, 0);

    const tasks = await listBackgroundTasks({ type: 'connector.init' });
    assert.equal(tasks.length, 0);
  });
});

test('reconciler: alternate connection shape (toolkit as string, connected_account_id field) is accepted', async () => {
  // Composio's API has been observed to use both `toolkit: { slug: X }` and
  // `toolkit: 'X'`; same for `id` vs `connected_account_id`. Lock both.
  await withTempHome(async () => {
    const r = await reconcileActiveConnectorAccounts({
      userId: 'u',
      fetcher: staticFetcher([
        { connected_account_id: 'acc-x', toolkit: 'github' },
      ]),
    });
    assert.equal(r.enqueued, 1);
    const t = await getBackgroundTaskByIdempotencyKey(
      'connector.init:github:acc-x:v1',
    );
    assert.ok(t);
  });
});

test('reconciler: defaultLimit override propagates into payload', async () => {
  await withTempHome(async () => {
    await reconcileActiveConnectorAccounts({
      userId: 'u',
      defaultLimit: 25,
      fetcher: staticFetcher([{ id: 'acc-g', toolkit: { slug: 'gmail' } }]),
    });
    const t = await getBackgroundTaskByIdempotencyKey(
      'connector.init:gmail:acc-g:v1',
    );
    assert.equal(t!.payload.limit, 25);
  });
});

test('reconciler: when CONNECTOR_INIT_DEFAULT_LIMIT env is set and no override given, env wins', async () => {
  await withTempHome(async () => {
    const previous = process.env.CONNECTOR_INIT_DEFAULT_LIMIT;
    process.env.CONNECTOR_INIT_DEFAULT_LIMIT = '50';
    try {
      await reconcileActiveConnectorAccounts({
        userId: 'u',
        fetcher: staticFetcher([{ id: 'acc-g', toolkit: { slug: 'gmail' } }]),
      });
      const t = await getBackgroundTaskByIdempotencyKey(
        'connector.init:gmail:acc-g:v1',
      );
      assert.equal(t!.payload.limit, 50);
    } finally {
      if (previous === undefined) delete process.env.CONNECTOR_INIT_DEFAULT_LIMIT;
      else process.env.CONNECTOR_INIT_DEFAULT_LIMIT = previous;
    }
  });
});
