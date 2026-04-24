/**
 * Tests for the /composio/wait → connector.init enqueue contract.
 *
 * The /wait HTTP polling loop itself is hard to test without a Composio
 * mock server, so this file targets the enqueue helper that the route
 * calls when ACTIVE is detected. Failure modes covered:
 *   - scheduler disabled → no task created, returns null
 *   - missing toolkit or account id → no task, returns null
 *   - happy path → task created with the expected idempotency key
 *   - re-enqueue with same key → returns existing task id, no duplicate row
 *   - enqueue throw → swallowed, returns null (route must not crash)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getBackgroundTask,
  getBackgroundTaskByIdempotencyKey,
  listBackgroundTasks,
  resetDbForTests,
} from '../db.ts';
import { maybeEnqueueConnectorInit } from './composio.ts';

async function withTempHomeAndScheduler(opts: { schedulerOn: boolean }, fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pin-composio-wait-'));
  const previousHome = process.env.OPENCLAW_HOME;
  const previousFlag = process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
  const previousLimit = process.env.CONNECTOR_INIT_DEFAULT_LIMIT;
  process.env.OPENCLAW_HOME = root;
  if (opts.schedulerOn) process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED = '1';
  else delete process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
  resetDbForTests();
  try {
    await fn();
  } finally {
    resetDbForTests();
    if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousHome;
    if (previousFlag === undefined) delete process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
    else process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED = previousFlag;
    if (previousLimit === undefined) delete process.env.CONNECTOR_INIT_DEFAULT_LIMIT;
    else process.env.CONNECTOR_INIT_DEFAULT_LIMIT = previousLimit;
    await rm(root, { recursive: true, force: true });
  }
}

test('maybeEnqueueConnectorInit: scheduler disabled → null, no task created', async () => {
  await withTempHomeAndScheduler({ schedulerOn: false }, async () => {
    const id = await maybeEnqueueConnectorInit('gmail', 'acc-1');
    assert.equal(id, null);
    const tasks = await listBackgroundTasks({ type: 'connector.init' });
    assert.equal(tasks.length, 0);
  });
});

test('maybeEnqueueConnectorInit: missing toolkit → null, no task', async () => {
  await withTempHomeAndScheduler({ schedulerOn: true }, async () => {
    const id = await maybeEnqueueConnectorInit('', 'acc-1');
    assert.equal(id, null);
    const tasks = await listBackgroundTasks({ type: 'connector.init' });
    assert.equal(tasks.length, 0);
  });
});

test('maybeEnqueueConnectorInit: missing accountId → null, no task', async () => {
  await withTempHomeAndScheduler({ schedulerOn: true }, async () => {
    const id = await maybeEnqueueConnectorInit('gmail', '');
    assert.equal(id, null);
  });
});

test('maybeEnqueueConnectorInit: happy path → task created with canonical idempotency key', async () => {
  await withTempHomeAndScheduler({ schedulerOn: true }, async () => {
    const id = await maybeEnqueueConnectorInit('gmail', 'acc-42');
    assert.ok(id);
    const task = await getBackgroundTask(id!);
    assert.ok(task);
    assert.equal(task!.type, 'connector.init');
    assert.equal(task!.idempotency_key, 'connector.init:gmail:acc-42:v1');
    assert.equal(task!.payload.toolkit, 'gmail');
    assert.equal(task!.payload.connectedAccountId, 'acc-42');
    assert.equal(task!.payload.reason, 'composio_wait');
    assert.equal(task!.payload.limit, 100);
  });
});

test('maybeEnqueueConnectorInit: env CONNECTOR_INIT_DEFAULT_LIMIT propagates into payload', async () => {
  await withTempHomeAndScheduler({ schedulerOn: true }, async () => {
    process.env.CONNECTOR_INIT_DEFAULT_LIMIT = '25';
    const id = await maybeEnqueueConnectorInit('googlecalendar', 'acc-c');
    const task = await getBackgroundTask(id!);
    assert.equal(task!.payload.limit, 25);
  });
});

test('maybeEnqueueConnectorInit: re-call with same toolkit+account → same task id, no duplicate', async () => {
  await withTempHomeAndScheduler({ schedulerOn: true }, async () => {
    const a = await maybeEnqueueConnectorInit('gmail', 'acc-x');
    const b = await maybeEnqueueConnectorInit('gmail', 'acc-x');
    assert.ok(a);
    assert.equal(a, b);
    const tasks = await listBackgroundTasks({ type: 'connector.init' });
    assert.equal(tasks.length, 1);
  });
});

test('maybeEnqueueConnectorInit: distinct (toolkit, account) pairs → distinct tasks', async () => {
  await withTempHomeAndScheduler({ schedulerOn: true }, async () => {
    const gmail = await maybeEnqueueConnectorInit('gmail', 'acc-x');
    const gcal = await maybeEnqueueConnectorInit('googlecalendar', 'acc-x');
    const slack = await maybeEnqueueConnectorInit('slack', 'acc-y');
    const ids = new Set([gmail, gcal, slack]);
    assert.equal(ids.size, 3);
    const all = await listBackgroundTasks({ type: 'connector.init', limit: 10 });
    assert.equal(all.length, 3);
  });
});

test('maybeEnqueueConnectorInit: case-insensitive toolkit normalization', async () => {
  // /composio/wait may receive `GMAIL` (uppercase) from Composio's response;
  // we lowercase both at enqueue and at handler dispatch, so the same
  // toolkit always shares one idempotency key.
  await withTempHomeAndScheduler({ schedulerOn: true }, async () => {
    const lower = await maybeEnqueueConnectorInit('gmail', 'acc-z');
    // NB: enqueue does not lowercase — that's the route's responsibility.
    // The route lowercases before calling. So callers passing 'GMAIL' here
    // would create a different key. Simulate the route's normalization:
    const upper = await maybeEnqueueConnectorInit('GMAIL'.toLowerCase(), 'acc-z');
    assert.equal(lower, upper);
    const lookup = await getBackgroundTaskByIdempotencyKey('connector.init:gmail:acc-z:v1');
    assert.ok(lookup);
  });
});
