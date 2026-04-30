/**
 * Tests for the connector.sync handler.
 *
 * Mirrors connector-init.test.ts shape (mock ComposioFetcher, real
 * scheduler, real DB) but covers the parts that are sync-specific:
 *   - cursor read/write: first run bootstraps, second run uses last_synced_at
 *   - Composio queries include the cursor as `query: after:<unix>` /
 *     `updatedMin: <iso>` / `since: <iso>` / `q: modifiedTime > '<iso>'`
 *   - failure leaves the cursor untouched so the next attempt re-pulls
 *   - discord skips with no_incremental_sync_v0 (snapshot toolkit)
 *   - kill switch CONNECTOR_SYNC_DISABLED_TOOLKITS short-circuits
 *
 * Cross-handler dedupe (init+sync overlap → no duplicate raw rows or
 * signals) is implicitly covered because both use raw.db.dedupe_key UNIQUE
 * + buildSignalsForInit's stable :init:v1 signal dedupeKey suffix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  enqueueBackgroundTask,
  getBackgroundTask,
  getEvolutionRun,
  listPersonalSignals,
  getConnectorSyncCursor,
  upsertConnectorSyncCursor,
  resetDbForTests,
} from '../../db.ts';
import {
  listGmailMessages,
  listGcalEvents,
  resetRawDbForTests,
} from '../../raw-db.ts';
import { BackgroundTaskScheduler } from '../scheduler.ts';
import {
  createConnectorSyncHandler,
  type ConnectorSyncResult,
} from './connector-sync.ts';
import type { ComposioFetcher } from './connector-init.ts';

// ──────────────────────────────────────────────────────────────────────
// Test harness (mirrors connector-init.test.ts)
// ──────────────────────────────────────────────────────────────────────

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-conn-sync-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  delete process.env.CONNECTOR_SYNC_DISABLED_TOOLKITS;
  try {
    return await fn();
  } finally {
    resetDbForTests();
    resetRawDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    delete process.env.CONNECTOR_SYNC_DISABLED_TOOLKITS;
    await rm(root, { recursive: true, force: true });
  }
}

interface CallLog {
  path: string;
  body: any;
}

function makeRecordingFetcher(
  handlers: Record<string, (body: any) => any>,
): { fetcher: ComposioFetcher; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const fetcher: ComposioFetcher = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) throw new Error(`mock fetcher: unhandled path ${path}`);
    return handler(body);
  };
  return { fetcher, calls };
}

function gmailMessage(opts: {
  id: string;
  threadId?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  internalDate?: number;
}) {
  return {
    id: opts.id,
    threadId: opts.threadId ?? `thr-${opts.id}`,
    snippet: opts.snippet ?? '',
    internalDate: opts.internalDate ?? Date.now(),
    payload: {
      headers: [
        opts.from && { name: 'From', value: opts.from },
        opts.subject && { name: 'Subject', value: opts.subject },
      ].filter(Boolean),
    },
    labelIds: ['INBOX'],
  };
}

function gcalEvent(opts: {
  id: string;
  calendarId?: string;
  summary?: string;
}) {
  return {
    id: opts.id,
    calendarId: opts.calendarId ?? 'primary',
    summary: opts.summary,
    start: { dateTime: new Date().toISOString() },
    end: { dateTime: new Date(Date.now() + 3600_000).toISOString() },
    status: 'confirmed',
  };
}

async function runOneTick(
  handlerDeps: Parameters<typeof createConnectorSyncHandler>[0],
): Promise<{
  task: NonNullable<Awaited<ReturnType<typeof getBackgroundTask>>>;
  result: ConnectorSyncResult | null;
}> {
  const scheduler = new BackgroundTaskScheduler({
    workerId: 'sync-test',
    leaseDurationMs: 60_000,
  });
  scheduler.registerHandler('connector.sync', createConnectorSyncHandler(handlerDeps));
  await scheduler.tick();
  const tasks = await import('../../db.ts').then((m) =>
    m.listBackgroundTasks({ type: 'connector.sync', limit: 10 }),
  );
  const task = tasks[0]!;
  const result = task.result as unknown as ConnectorSyncResult | null;
  return { task, result };
}

// ──────────────────────────────────────────────────────────────────────
// Bootstrap: first sync (no cursor) uses 24h lookback
// ──────────────────────────────────────────────────────────────────────

test('gmail bootstrap: no cursor → since defaults to ~24h ago, cursor written on success', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:gmail:acc-1:0',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 5, reason: 'enqueuer' },
    });

    const { fetcher, calls } = makeRecordingFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        data: { messages: [
          gmailMessage({ id: 's1', from: 'alice@x.com', subject: 'New', snippet: 'New email' }),
          gmailMessage({ id: 's2', from: 'bob@x.com', subject: 'Update', snippet: 'Status' }),
        ] },
      }),
    });

    const { task, result } = await runOneTick({ fetcher, userId: 'test-user' });

    assert.equal(task.status, 'succeeded');
    assert.equal(result?.toolkit, 'gmail');
    assert.equal(result?.rawInserted, 2);
    assert.equal(result?.signalsInserted, 2);

    // Composio call carried `query: after:<unix>` ~24h before now
    const call = calls.find((c) => c.path === '/tools/execute/GMAIL_FETCH_EMAILS')!;
    const query = call.body.arguments.query as string;
    assert.match(query, /^after:\d+$/);
    const sec = Number(query.slice('after:'.length));
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(nowSec - sec >= 23 * 3600 && nowSec - sec <= 25 * 3600,
      `expected since ~24h ago, got ${nowSec - sec}s`);

    // Cursor row written
    const cursor = await getConnectorSyncCursor('gmail', 'acc-1');
    assert.ok(cursor, 'cursor should be written on success');
    assert.equal(cursor!.toolkit, 'gmail');
    assert.equal(cursor!.connected_account_id, 'acc-1');
    assert.equal(cursor!.last_synced_at, result!.syncedThrough);

    // Raw + signals exist
    assert.equal(listGmailMessages({ limit: 10 }).length, 2);
    const sigs = await listPersonalSignals({ kind: 'connector.gmail.message', limit: 10 });
    assert.equal(sigs.length, 2);

    // evolution_run completed (no LLM injected so memoriesWritten=0 and run is completed)
    const evo = await getEvolutionRun(result!.evolutionRunId!);
    assert.equal(evo!.status, 'completed');
    assert.equal(evo!.trigger_kind, 'on_event');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Resume: cursor exists → since = last_synced_at
// ──────────────────────────────────────────────────────────────────────

test('gmail resume: cursor present → query uses cursor.last_synced_at as since', async () => {
  await withTempHome(async () => {
    // Plant cursor at a known time 6h ago
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000);
    await upsertConnectorSyncCursor({
      toolkit: 'gmail',
      connectedAccountId: 'acc-1',
      lastSyncedAt: sixHoursAgo.toISOString(),
    });

    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:gmail:acc-1:resume',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 10, reason: 'enqueuer' },
    });

    const { fetcher, calls } = makeRecordingFetcher({
      '/tools/execute/GMAIL_FETCH_EMAILS': () => ({
        messages: [gmailMessage({ id: 'after-cursor', subject: 'fresh' })],
      }),
    });

    const { task, result } = await runOneTick({ fetcher, userId: 'test-user' });

    assert.equal(task.status, 'succeeded');
    assert.equal(result?.rawInserted, 1);
    assert.equal(result?.sinceUsed, sixHoursAgo.toISOString());

    const call = calls.find((c) => c.path === '/tools/execute/GMAIL_FETCH_EMAILS')!;
    const query = call.body.arguments.query as string;
    const expectedSec = Math.floor(sixHoursAgo.getTime() / 1000);
    assert.equal(query, `after:${expectedSec}`);

    // Cursor was advanced
    const cursor = await getConnectorSyncCursor('gmail', 'acc-1');
    assert.notEqual(cursor!.last_synced_at, sixHoursAgo.toISOString());
    assert.equal(cursor!.last_synced_at, result!.syncedThrough);
  });
});

// ──────────────────────────────────────────────────────────────────────
// gcal cursor binding
// ──────────────────────────────────────────────────────────────────────

test('gcal: query uses updatedMin from cursor (not init\'s timeMin/timeMax window)', async () => {
  await withTempHome(async () => {
    const since = new Date(Date.now() - 2 * 3600_000);
    await upsertConnectorSyncCursor({
      toolkit: 'googlecalendar', connectedAccountId: 'acc-cal', lastSyncedAt: since.toISOString(),
    });
    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:gcal:acc-cal:1',
      payload: { toolkit: 'googlecalendar', connectedAccountId: 'acc-cal', limit: 5 },
    });
    const { fetcher, calls } = makeRecordingFetcher({
      '/tools/execute/GOOGLECALENDAR_EVENTS_LIST': () => ({
        data: { events: [gcalEvent({ id: 'evt-1', summary: 'Standup' })] },
      }),
    });

    const { task } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    const call = calls.find((c) => c.path === '/tools/execute/GOOGLECALENDAR_EVENTS_LIST')!;
    assert.equal(call.body.arguments.updatedMin, since.toISOString());
    // sync deliberately drops timeMin/timeMax (init had them)
    assert.equal(call.body.arguments.timeMin, undefined);
    assert.equal(call.body.arguments.timeMax, undefined);
    assert.equal(listGcalEvents({ limit: 10 }).length, 1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Failure preserves cursor
// ──────────────────────────────────────────────────────────────────────

test('Composio failure: cursor unchanged (next attempt re-pulls same window)', async () => {
  await withTempHome(async () => {
    const planted = new Date(Date.now() - 4 * 3600_000).toISOString();
    await upsertConnectorSyncCursor({
      toolkit: 'gmail', connectedAccountId: 'acc-1', lastSyncedAt: planted,
    });
    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:gmail:acc-1:fail',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 5 },
      maxAttempts: 1, // single shot — failure should terminate immediately
    });
    const fetcher: ComposioFetcher = async () => { throw new Error('rate limited'); };

    const { task } = await runOneTick({ fetcher });
    assert.equal(task.status, 'failed');
    assert.equal(task.last_error_code, 'composio_fetch_failed');
    assert.match(task.last_error_message ?? '', /rate limited/);

    // Cursor stayed at the planted value
    const cursor = await getConnectorSyncCursor('gmail', 'acc-1');
    assert.equal(cursor!.last_synced_at, planted);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Discord skipped (no incremental semantic)
// ──────────────────────────────────────────────────────────────────────

test('discord: skipped with no_incremental_sync_v0 — no Composio call, no cursor', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:discord:acc-d:1',
      payload: { toolkit: 'discord', connectedAccountId: 'acc-d', limit: 5 },
    });
    const { fetcher, calls } = makeRecordingFetcher({});

    const { task } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(task.result?.skipped, true);
    assert.equal(task.result?.reason, 'no_incremental_sync_v0');
    // No Composio calls were made (handler short-circuits before fetcher use)
    assert.equal(calls.length, 0);
    // No cursor row created
    assert.equal(await getConnectorSyncCursor('discord', 'acc-d'), null);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Unsupported toolkit
// ──────────────────────────────────────────────────────────────────────

test('unsupported toolkit (oura): skipped with unsupported_toolkit_v0', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:oura:acc-x:1',
      payload: { toolkit: 'oura', connectedAccountId: 'acc-x', limit: 5 },
    });
    const { fetcher } = makeRecordingFetcher({});
    const { task } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(task.result?.skipped, true);
    assert.equal(task.result?.reason, 'unsupported_toolkit_v0');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Kill switch
// ──────────────────────────────────────────────────────────────────────

test('CONNECTOR_SYNC_DISABLED_TOOLKITS=gmail: skipped with toolkit_disabled', async () => {
  await withTempHome(async () => {
    process.env.CONNECTOR_SYNC_DISABLED_TOOLKITS = 'gmail,slack';
    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:gmail:acc-1:disabled',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 5 },
    });
    const { fetcher, calls } = makeRecordingFetcher({});
    const { task } = await runOneTick({ fetcher });
    assert.equal(task.status, 'succeeded');
    assert.equal(task.result?.skipped, true);
    assert.equal(task.result?.reason, 'toolkit_disabled');
    assert.equal(calls.length, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Cross-handler dedupe: init then sync overlap → no duplicate raw rows
// ──────────────────────────────────────────────────────────────────────

test('init + overlapping sync: same gmail message produces no duplicate raw row or signal', async () => {
  await withTempHome(async () => {
    // Run init first to land message m1
    const { createConnectorInitHandler } = await import('./connector-init.ts');
    await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:gmail:acc-1:v1',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 3 },
    });
    const initFetcher: ComposioFetcher = async () => ({
      data: { messages: [
        gmailMessage({ id: 'shared', from: 'a@x.com', subject: 'Shared msg', snippet: 'overlap test' }),
      ] },
    });
    const initSched = new BackgroundTaskScheduler({ workerId: 'init', leaseDurationMs: 60_000 });
    initSched.registerHandler('connector.init', createConnectorInitHandler({ fetcher: initFetcher, userId: 'test-user' }));
    await initSched.tick();
    assert.equal(listGmailMessages({ limit: 10 }).length, 1);
    const sigsAfterInit = await listPersonalSignals({ kind: 'connector.gmail.message', limit: 10 });
    assert.equal(sigsAfterInit.length, 1);

    // Now sync re-pulls the SAME message
    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:gmail:acc-1:overlap',
      payload: { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 5 },
    });
    const syncFetcher: ComposioFetcher = async () => ({
      messages: [gmailMessage({ id: 'shared', from: 'a@x.com', subject: 'Shared msg', snippet: 'overlap test' })],
    });
    const { task, result } = await runOneTick({ fetcher: syncFetcher, userId: 'test-user' });

    assert.equal(task.status, 'succeeded');
    // The raw insert and signal insert should both be 0 (full dedupe)
    assert.equal(result?.rawInserted, 0);
    assert.equal(result?.rawIgnored, 1);
    assert.equal(result?.signalsInserted, 0);

    // raw + signals counts unchanged
    assert.equal(listGmailMessages({ limit: 10 }).length, 1);
    const sigsAfterSync = await listPersonalSignals({ kind: 'connector.gmail.message', limit: 10 });
    assert.equal(sigsAfterSync.length, 1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Payload validation
// ──────────────────────────────────────────────────────────────────────

test('payload validation: missing toolkit → terminal failed', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'connector.sync',
      idempotencyKey: 'connector.sync:bad:1',
      payload: { connectedAccountId: 'acc-1' } as any,
      maxAttempts: 1,
    });
    const { fetcher } = makeRecordingFetcher({});
    const { task } = await runOneTick({ fetcher });
    assert.equal(task.status, 'failed');
    assert.equal(task.last_error_code, 'invalid_payload');
  });
});
