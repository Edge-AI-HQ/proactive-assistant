/**
 * Tests for BackgroundTaskScheduler — the in-process tick loop that
 * drives background_tasks. Uses the real db.ts repository (no mocks),
 * scoped to OPENCLAW_HOME tmpdir so tests run independently.
 *
 * Coverage:
 *   - tick claims registered-type tasks only; unhandled types are skipped
 *   - successful handler → row goes to 'succeeded' with result
 *   - throwing handler → row goes back to 'queued' with backoff (until max)
 *   - max-attempts handler crash → terminal 'failed'
 *   - heartbeat from inside handler extends lease
 *   - reaper sweeps stale leases from a previous tick
 *   - tick is in-process serialized (overlapping calls don't double-claim)
 *   - stop() awaits in-flight tick
 *   - registerHandler rejects duplicates
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  enqueueBackgroundTask,
  getBackgroundTask,
  listTaskAttempts,
  resetDbForTests,
} from '../db.ts';
import {
  BackgroundTaskScheduler,
  type TaskHandler,
  type TaskHandlerResult,
} from './scheduler.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-bg-sched-'));
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

function makeScheduler(handler: TaskHandler, type = 't'): BackgroundTaskScheduler {
  const s = new BackgroundTaskScheduler({
    workerId: 'test-worker',
    leaseDurationMs: 1_000,
  });
  s.registerHandler(type, handler);
  return s;
}

test('tick: no due tasks → empty report', async () => {
  await withTempHome(async () => {
    const s = makeScheduler(async () => ({ status: 'succeeded' }));
    const report = await s.tick();
    assert.equal(report.ranTaskId, null);
    assert.equal(report.recoveredRequeued, 0);
  });
});

test('tick: successful handler → task succeeded with result', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'ok' });
    const s = makeScheduler(async (ctx) => {
      assert.equal(ctx.task.id, e.task.id);
      assert.equal(ctx.attempt.attempt_no, 1);
      return { status: 'succeeded', result: { items: 7 } };
    });
    const report = await s.tick();
    assert.equal(report.ranTaskId, e.task.id);
    assert.equal(report.ranStatus, 'succeeded');

    const after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'succeeded');
    assert.deepEqual(after!.result, { items: 7 });
    assert.equal(after!.lease_token, null);

    const attempts = await listTaskAttempts(e.task.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, 'succeeded');
  });
});

test('tick: handler throws → fail+retry; eventually terminal failed', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'crash', maxAttempts: 2,
    });
    let calls = 0;
    const s = makeScheduler(async () => {
      calls += 1;
      throw new Error(`boom ${calls}`);
    });

    // Attempt 1 → handler throws → requeued
    await s.tick();
    let after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'queued');
    assert.equal(after!.attempts, 1);
    assert.equal(after!.last_error_code, 'handler_threw');

    // Wait out the default 30s backoff by manipulating run_after directly
    // is too invasive; instead enqueue a fresh "no backoff" path by
    // setting the run_after in the past via a re-enqueue trick. Simpler:
    // make a fresh scheduler call after manually clearing run_after.
    const path = (await import('node:path')).default;
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(process.env.OPENCLAW_HOME!, 'data', 'proactive.db');
    const handle = new Database(dbPath);
    try {
      handle.prepare(
        "UPDATE background_tasks SET run_after = '1970-01-01T00:00:00Z' WHERE id = ?",
      ).run(e.task.id);
    } finally {
      handle.close();
    }

    // Attempt 2 → throws again → max_attempts hit → terminal failed
    await s.tick();
    after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'failed');
    assert.equal(after!.attempts, 2);
    assert.equal(calls, 2);

    // Attempt rows show full audit
    const attempts = await listTaskAttempts(e.task.id);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((a) => a.status === 'failed'));
  });
});

test('tick: handler returning failed status (without throwing) is treated as fail', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'soft-fail', maxAttempts: 1,
    });
    const s = makeScheduler(async () => ({
      status: 'failed' as const,
      errorCode: 'composio_500',
      errorMessage: 'Composio returned HTTP 500',
    }));
    await s.tick();
    const after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'failed');
    assert.equal(after!.last_error_code, 'composio_500');
    assert.equal(after!.last_error_message, 'Composio returned HTTP 500');
  });
});

test('tick: skipped status is recorded as succeeded with result.skipped=true', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'skip',
    });
    const s = makeScheduler(async () => ({
      status: 'skipped' as const,
      result: { reason: 'pipeline_already_running' },
    }));
    await s.tick();
    const after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'succeeded');
    assert.deepEqual(after!.result, {
      reason: 'pipeline_already_running',
      skipped: true,
    });
  });
});

test('tick: handler heartbeat extends lease + records progress', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'hb' });
    const s = new BackgroundTaskScheduler({
      workerId: 'w', leaseDurationMs: 60_000,
    });
    let originalExpiry: string | null = null;
    let extendedExpiry: string | null = null;
    s.registerHandler('t', async (ctx) => {
      originalExpiry = ctx.task.lease_expires_at;
      const ok = await ctx.heartbeat({ stage: 'fetch', got: 12 }, { leaseDurationMs: 90_000 });
      assert.equal(ok, true);
      const refreshed = await getBackgroundTask(ctx.task.id);
      extendedExpiry = refreshed!.lease_expires_at;
      assert.deepEqual(refreshed!.progress, { stage: 'fetch', got: 12 });
      return { status: 'succeeded' };
    });
    await s.tick();
    assert.ok(originalExpiry);
    assert.ok(extendedExpiry);
    assert.ok(extendedExpiry! > originalExpiry!);
  });
});

test('tick: only registered-type tasks are claimed', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 'unhandled', idempotencyKey: 'x' });
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'y' });
    let ran = '';
    const s = makeScheduler(async (ctx) => {
      ran = ctx.task.idempotency_key;
      return { status: 'succeeded' };
    });
    await s.tick();
    assert.equal(ran, 'y');

    // Unhandled task is still queued; nothing burned an attempt on it
    const unhandled = (await import('../db.ts')).getBackgroundTaskByIdempotencyKey;
    const u = await unhandled('x');
    assert.equal(u!.status, 'queued');
    assert.equal(u!.attempts, 0);
  });
});

test('tick: reaper requeues a stale running row before claiming', async () => {
  await withTempHome(async () => {
    // Stage a task that we'll claim manually + abandon
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'stale' });
    const db = await import('../db.ts');
    const claim = await db.claimNextDueBackgroundTask({
      workerId: 'crasher', leaseDurationMs: 1_000,
    });
    assert.ok(claim);

    // Force the lease into the past so the reaper picks it up
    const path = (await import('node:path')).default;
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(process.env.OPENCLAW_HOME!, 'data', 'proactive.db');
    const handle = new Database(dbPath);
    try {
      handle.prepare(
        "UPDATE background_tasks SET lease_expires_at = '1970-01-01T00:00:00Z', run_after = '1970-01-01T00:00:00Z' WHERE id = ?",
      ).run(e.task.id);
    } finally {
      handle.close();
    }

    let ran = false;
    const s = new BackgroundTaskScheduler({
      workerId: 'recovery-worker',
      leaseDurationMs: 1_000,
      recoveryBackoffMs: 0,  // requeue immediately so the same tick can re-claim
    });
    s.registerHandler('t', async () => { ran = true; return { status: 'succeeded' }; });

    const report = await s.tick();
    assert.equal(report.recoveredRequeued, 1);
    assert.equal(ran, true);

    const after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'succeeded');
    // Two attempts: the abandoned one + the recovery
    const attempts = await listTaskAttempts(e.task.id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.status, 'lost');
    assert.equal(attempts[1]!.status, 'succeeded');
  });
});

test('tick: overlapping ticks coalesce — only one claim happens', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'one' });
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'two' });
    let inFlight = 0;
    let maxConcurrent = 0;
    const s = makeScheduler(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Yield once so the second tick has a chance to start (and be coalesced)
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return { status: 'succeeded' };
    });
    const [a, b] = await Promise.all([s.tick(), s.tick()]);
    assert.equal(maxConcurrent, 1);
    // Whichever completed first ran the task; the other coalesced (empty)
    const ran = [a.ranTaskId, b.ranTaskId].filter(Boolean);
    assert.equal(ran.length, 1);
  });
});

test('tick: handler crash error message is truncated to 1000 chars', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'big-err', maxAttempts: 1,
    });
    const big = 'x'.repeat(5000);
    const s = makeScheduler(async () => { throw new Error(big); });
    await s.tick();
    const after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'failed');
    assert.ok((after!.last_error_message ?? '').length <= 1000);
  });
});

test('start/stop: stop awaits in-flight tick', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'sl' });
    let resolved: (() => void) | null = null;
    const tickGate = new Promise<void>((r) => { resolved = r; });
    const s = makeScheduler(async () => {
      await tickGate;
      return { status: 'succeeded' };
    });
    s.start();
    // Trigger a manual tick (don't wait for the interval)
    const tickPromise = s.tick();
    // Let the handler start blocking
    await new Promise((r) => setImmediate(r));
    // stop() should NOT return until the in-flight handler finishes
    let stopped = false;
    const stopP = s.stop().then(() => { stopped = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(stopped, false);
    resolved!();
    await tickPromise;
    await stopP;
    assert.equal(stopped, true);
  });
});

test('registerHandler: duplicate type throws', async () => {
  await withTempHome(async () => {
    const s = new BackgroundTaskScheduler({ workerId: 'w' });
    s.registerHandler('t', async () => ({ status: 'succeeded' }));
    assert.throws(
      () => s.registerHandler('t', async () => ({ status: 'succeeded' })),
      /duplicate handler/,
    );
  });
});

test('registerHandler: empty type throws', async () => {
  await withTempHome(async () => {
    const s = new BackgroundTaskScheduler({ workerId: 'w' });
    assert.throws(() => s.registerHandler('', async () => ({ status: 'succeeded' })), /type is required/);
  });
});

test('constructor: empty workerId throws', () => {
  assert.throws(() => new BackgroundTaskScheduler({ workerId: '' }), /workerId is required/);
});
